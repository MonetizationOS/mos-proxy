import { parse, parseSetCookie } from 'cookie'
import type { ClientMetadataProvider } from '../adapters/ClientMetadataProvider'
import type { Fetcher } from '../adapters/Fetcher'
import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { MOSConfig } from '../config'
import type { PipelineContext } from '../context'
import type { MOSProxyApiRetryHandler, SurfaceDecisionResponse } from '../types'
import fetchSurfaceDecisions from './fetchSurfaceDecisions'
import { parsePageMetadata } from './pageMetadata'

export default async function getSurfaceDecisions(
    ctx: PipelineContext,
    request: Request,
    response: Response,
    apiFetcher: Fetcher,
    rewriter: HtmlRewriterAdapter | null,
    clientMetadataProvider: ClientMetadataProvider | null,
    onApiRetry?: MOSProxyApiRetryHandler,
): Promise<[Response, SurfaceDecisionResponse | null]> {
    const { config, logger } = ctx
    const { anonymousIdentifier, userJwt } = getExistingCookies(request, response, config)

    const [metadataStream, passThroughStream] = response.body?.tee() ?? [null, null]
    const pageMetadata = metadataStream && rewriter ? await parsePageMetadata(ctx, new Response(metadataStream, response), rewriter) : {}
    let modifiedResponse = passThroughStream ? new Response(passThroughStream, response) : response

    const clientMetadata = clientMetadataProvider?.build(request) ?? {}

    let attempt = 0
    let result: Awaited<ReturnType<typeof fetchSurfaceDecisions>>
    let currentAnonymousIdentifier = anonymousIdentifier
    let currentUserJwt = userJwt

    while (true) {
        attempt++
        result = await fetchSurfaceDecisions(
            ctx,
            {
                anonymousIdentifier: currentAnonymousIdentifier,
                userJwt: currentUserJwt,
                path: new URL(request.url).pathname,
                url: request.url,
                clientMetadata,
                pageMetadata,
                userAgent: request.headers.get('User-Agent') ?? undefined,
                originStatus: response.status,
            },
            apiFetcher,
        )

        if (result.ok) {
            break
        }

        if (!onApiRetry) {
            break
        }

        if (attempt >= 2) {
            break
        }

        try {
            const retryDecision = await onApiRetry({
                error: result.error,
                reason: result.reason,
                status: result.status,
                statusCode: result.statusCode,
                attempt,
                request,
            })

            if (retryDecision?.retry) {
                if (retryDecision.identity) {
                    currentAnonymousIdentifier = retryDecision.identity.anonymousIdentifier
                    currentUserJwt = retryDecision.identity.userJwt
                }
                logger.log({
                    level: 'info',
                    code: 'surface-decisions-api-retry',
                    message: `Surface decisions API failed (attempt ${attempt}). Retrying...`,
                    context: {
                        reason: result.reason,
                        status: result.status,
                        statusCode: result.statusCode,
                    },
                })
                continue
            }
        } catch (retryError) {
            logger.log({
                level: 'warn',
                code: 'surface-decisions-api-retry-handler-threw',
                message: 'onApiRetry handler threw an error.',
                error: retryError,
            })
        }
        break
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
            },
            error: result.error,
        })
        return [modifiedResponse, null]
    }

    const surfaceDecisions = result.data

    if (!currentAnonymousIdentifier && !currentUserJwt && surfaceDecisions?.identity?.identifier) {
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
