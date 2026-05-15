import { parse, parseSetCookie } from 'cookie'
import type { ClientMetadataProvider } from '../adapters/ClientMetadataProvider'
import type { Fetcher } from '../adapters/Fetcher'
import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { MOSConfig } from '../config'
import type { PipelineContext } from '../context'
import type { PageMetadata, SurfaceDecisionResponse } from '../types'
import fetchSurfaceDecisions from './fetchSurfaceDecisions'
import { parsePageMetadata } from './pageMetadata'

export default async function getSurfaceDecisions(
    ctx: PipelineContext,
    request: Request,
    response: Response,
    apiFetcher: Fetcher,
    rewriter: HtmlRewriterAdapter | null,
    clientMetadataProvider: ClientMetadataProvider | null,
    // When provided (i.e. linkRewriting already extracted it during its parse pass), we drain a
    // tee branch to drive the upstream rewriter to completion and read from this object — saving
    // one full HTML parse compared to running parsePageMetadata separately.
    providedPageMetadata: PageMetadata | null = null,
): Promise<[Response, SurfaceDecisionResponse | null]> {
    const { config, logger } = ctx
    const { anonymousIdentifier, userJwt } = getExistingCookies(request, response, config)

    const [metadataStream, passThroughStream] = response.body?.tee() ?? [null, null]
    let pageMetadata: PageMetadata = {}
    if (providedPageMetadata && metadataStream) {
        // Drain the tee branch so the upstream linkRewriting session runs end-to-end; that
        // mutates providedPageMetadata as <meta> elements pass through.
        await drainStream(metadataStream)
        pageMetadata = providedPageMetadata
    } else if (metadataStream && rewriter) {
        pageMetadata = await parsePageMetadata(ctx, new Response(metadataStream, response), rewriter)
    }
    let modifiedResponse = passThroughStream ? new Response(passThroughStream, response) : response

    const clientMetadata = clientMetadataProvider?.build(request) ?? {}

    const result = await fetchSurfaceDecisions(
        ctx,
        {
            anonymousIdentifier,
            userJwt,
            path: new URL(request.url).pathname,
            url: request.url,
            clientMetadata,
            pageMetadata,
            userAgent: request.headers.get('User-Agent') ?? undefined,
            originStatus: response.status,
        },
        apiFetcher,
    )

    if (!result.ok) {
        logger.log({
            level: 'warn',
            code: 'surface-decisions-api-failed',
            message: 'Surface decisions API failed; continuing with the origin response.',
            context: {
                reason: result.reason,
                status: result.status,
                statusCode: result.statusCode,
            },
            error: result.error,
        })
        return [modifiedResponse, null]
    }

    const surfaceDecisions = result.data

    if (!anonymousIdentifier && !userJwt && surfaceDecisions?.identity?.identifier) {
        const headers = new Headers(modifiedResponse.headers)
        headers.append('Set-Cookie', `${config.anonymousSessionCookieName}=${surfaceDecisions.identity.identifier}; Path=/`)
        modifiedResponse = new Response(modifiedResponse.body, {
            status: modifiedResponse.status,
            statusText: modifiedResponse.statusText,
            headers,
        })
    }

    return [modifiedResponse, surfaceDecisions]
}

const drainStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    try {
        while (!(await reader.read()).done) {
            // discard
        }
    } finally {
        reader.releaseLock()
    }
}

const getExistingCookies = (request: Request, originResponse: Response, config: MOSConfig) => {
    const setCookies = originResponse.headers.getSetCookie().map((header) => parseSetCookie(header))
    const originAnonymousCookie = setCookies.find((s) => s.name === config.anonymousSessionCookieName)
    const originUserJwtCookie = setCookies.find((s) => s.name === config.authenticatedUserJwtCookieName)
    if (originAnonymousCookie || originUserJwtCookie) {
        return { anonymousIdentifier: originAnonymousCookie?.value, userJwt: originUserJwtCookie?.value }
    }

    const cookies = parse(request.headers.get('Cookie') || '')
    const anonymousIdentifier = cookies[config.anonymousSessionCookieName]
    const userJwt = cookies[config.authenticatedUserJwtCookieName]
    return { anonymousIdentifier, userJwt }
}
