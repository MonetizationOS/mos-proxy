import { parse, parseSetCookie } from 'cookie'
import type { ClientMetadataProvider } from '../adapters/ClientMetadataProvider'
import type { Fetcher } from '../adapters/Fetcher'
import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { MOSConfig } from '../config'
import type { PipelineContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import fetchSurfaceDecisions, { type FetchSurfaceDecisionsResult } from './fetchSurfaceDecisions'
import { parsePageMetadata } from './pageMetadata'

export default async function getSurfaceDecisions(
    ctx: PipelineContext,
    request: Request,
    response: Response,
    apiFetcher: Fetcher,
    rewriter: HtmlRewriterAdapter | null,
    clientMetadataProvider: ClientMetadataProvider | null,
): Promise<[Response, SurfaceDecisionResponse | null]> {
    const { config, logger } = ctx
    const { anonymousIdentifier, userJwt } = getExistingCookies(request, response, config)

    const [metadataStream, passThroughStream] = response.body?.tee() ?? [null, null]
    const pageMetadata = metadataStream && rewriter ? await parsePageMetadata(ctx, new Response(metadataStream, response), rewriter) : {}
    let modifiedResponse = passThroughStream ? new Response(passThroughStream, response) : response

    const clientMetadata = clientMetadataProvider?.build(request) ?? {}
    const fetchArgs = {
        path: new URL(request.url).pathname,
        url: request.url,
        clientMetadata,
        pageMetadata,
        userAgent: request.headers.get('User-Agent') ?? undefined,
        originStatus: response.status,
    }

    let result = await fetchSurfaceDecisions(
        ctx,
        {
            ...fetchArgs,
            anonymousIdentifier,
            userJwt,
        },
        apiFetcher,
    )

    let retriedAsAnonymous = false
    if (!result.ok && userJwt && isUnauthorized(result)) {
        logger.log({
            level: 'warn',
            code: 'surface-decisions-jwt-rejected',
            message: 'Surface decisions rejected the user JWT; retrying as anonymous.',
            context: {
                reason: result.reason,
                status: result.status,
                statusCode: result.statusCode,
            },
            error: result.error,
        })

        result = await fetchSurfaceDecisions(
            ctx,
            {
                ...fetchArgs,
                anonymousIdentifier,
            },
            apiFetcher,
        )
        retriedAsAnonymous = true
    }

    if (!result.ok) {
        logger.log({
            level: 'warn',
            code: 'surface-decisions-api-failed',
            message: 'Surface decisions API failed; continuing with the origin response.',
            context: {
                reason: result.reason,
                status: result.status,
                statusCode: result.statusCode,
                retriedAsAnonymous,
            },
            error: result.error,
        })
        return [modifiedResponse, null]
    }

    const surfaceDecisions = result.data
    modifiedResponse = applyIdentityCookies(
        modifiedResponse,
        config,
        { anonymousIdentifier, userJwt },
        surfaceDecisions,
        retriedAsAnonymous,
    )

    return [modifiedResponse, surfaceDecisions]
}

const isUnauthorized = (result: Extract<FetchSurfaceDecisionsResult, { ok: false }>): boolean =>
    result.status === 401 || result.statusCode === 401

const applyIdentityCookies = (
    response: Response,
    config: MOSConfig,
    identity: { anonymousIdentifier?: string | undefined; userJwt?: string | undefined },
    surfaceDecisions: SurfaceDecisionResponse,
    clearUserJwt: boolean,
): Response => {
    const headers = new Headers(response.headers)
    let changed = false

    const shouldSetAnonymousCookie =
        Boolean(surfaceDecisions.identity?.identifier) && !identity.anonymousIdentifier && (!identity.userJwt || clearUserJwt)

    if (shouldSetAnonymousCookie) {
        headers.append('Set-Cookie', `${config.anonymousSessionCookieName}=${surfaceDecisions.identity.identifier}; Path=/`)
        changed = true
    }

    if (clearUserJwt) {
        headers.append('Set-Cookie', `${config.authenticatedUserJwtCookieName}=; Path=/; Max-Age=0`)
        changed = true
    }

    if (!changed) {
        return response
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
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
