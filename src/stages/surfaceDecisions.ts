import { parse } from 'cookie'
import type { ClientIPProvider } from '../adapters/ClientIPProvider'
import { normalizeClientIP } from '../adapters/ClientIPProvider'
import type { ClientMetadataProvider } from '../adapters/ClientMetadataProvider'
import type { Fetcher } from '../adapters/Fetcher'
import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import {
    defaultPersistIdentity,
    defaultResolveIdentity,
    getExistingCookies,
    type Identity,
    type IdentityProvider,
    type ResolveIdentityArgs,
} from '../adapters/IdentityProvider'
import type { ResourceProvider } from '../adapters/ResourceProvider'
import type { PipelineContext } from '../context'
import type { MOSProxyJwtExpiredHandler } from '../MOSProxy'
import { selectSurfaceDecisionCookies } from '../surfaceDecisionCookies'
import type { ModifyHttpResponse, SurfaceDecisionResponse } from '../types'
import fetchSurfaceDecisions from './fetchSurfaceDecisions'
import { parsePageMetadata } from './pageMetadata'
import { applyHttpBehavior } from './surfaceBehavior'

/** Set on the expired-JWT redirect so the follow-up navigation falls back instead of redirecting again. */
const JWT_REFRESH_GUARD_COOKIE = 'mos-jwt-refresh'
const JWT_REFRESH_GUARD_SET_COOKIE = `${JWT_REFRESH_GUARD_COOKIE}=1; Max-Age=30; Path=/; Secure; HttpOnly; SameSite=Lax`
const JWT_EXPIRED_CODE = 'jwt_expired'

export default async function getSurfaceDecisions(
    ctx: PipelineContext,
    request: Request,
    response: Response,
    apiFetcher: Fetcher,
    rewriter: HtmlRewriterAdapter | null,
    clientMetadataProvider: ClientMetadataProvider | null,
    clientIpProvider: ClientIPProvider | null,
    identityProvider: IdentityProvider | null,
    resourceProvider: ResourceProvider | null,
    onJwtExpired: MOSProxyJwtExpiredHandler | null = null,
): Promise<[Response, SurfaceDecisionResponse | null]> {
    const { config, logger } = ctx

    // A custom resolve owns the identity payload; the expired-JWT hints apply to the default only.
    const resolve = identityProvider?.resolve ?? resolveWithJwtRequestHints
    let identity: Identity
    try {
        identity = await resolve({ request, originResponse: response, config, logger })
    } catch (error) {
        logger.log({
            level: 'warn',
            code: 'identity-resolve-failed',
            message: 'Identity provider resolve threw; skipping surface decisions and returning origin response.',
            error,
        })
        return [response, null]
    }

    const [metadataStream, passThroughStream] = response.body?.tee() ?? [null, null]
    const pageMetadata = metadataStream && rewriter ? await parsePageMetadata(ctx, new Response(metadataStream, response), rewriter) : {}
    let modifiedResponse = passThroughStream ? new Response(passThroughStream, response) : response

    const clientMetadata = clientMetadataProvider?.build(request) ?? {}

    const resource = { id: new URL(request.url).pathname, meta: pageMetadata, ...resourceProvider?.build(request) }

    const result = await fetchSurfaceDecisions(
        ctx,
        {
            identity,
            url: request.url,
            clientMetadata,
            resource,
            userAgent: request.headers.get('User-Agent') ?? undefined,
            clientIP: normalizeClientIP(clientIpProvider?.(request)),
            referer: request.headers.get('Referer') ?? undefined,
            cookies: selectSurfaceDecisionCookies(request.headers.get('Cookie'), response, config.surfaceDecisionsCookiePatterns),
            originStatus: response.status,
        },
        apiFetcher,
    )

    if (!result.ok && result.code === JWT_EXPIRED_CODE) {
        const expiredResponse = await handleJwtExpired(ctx, request, result.http, onJwtExpired)
        if (expiredResponse) {
            modifiedResponse.body?.cancel().catch(() => {})
            return [expiredResponse, null]
        }
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

    const persist = identityProvider?.persist ?? defaultPersistIdentity
    try {
        modifiedResponse = await persist({
            resolved: identity,
            decisions: surfaceDecisions,
            response: modifiedResponse,
            request,
            config,
            logger,
        })
    } catch (error) {
        logger.log({
            level: 'warn',
            code: 'identity-persist-failed',
            message: 'Identity provider persist threw; keeping pre-persist response.',
            error,
        })
    }

    return [modifiedResponse, surfaceDecisions]
}

/** Default identity plus what the proxy can see about the request, for a JWT identity. */
const resolveWithJwtRequestHints = (args: ResolveIdentityArgs): Identity => {
    const identity = defaultResolveIdentity(args)
    if (!('userJwt' in identity)) {
        return identity
    }
    const anonymousIdentifier = getExistingCookies(args.request, args.originResponse, args.config).anonymousIdentifier
    const jwtExpiredHandling = canShortCircuitExpiredJwt(args.request) ? 'shortCircuit' : undefined
    return {
        ...identity,
        ...(anonymousIdentifier && { anonymousIdentifier }),
        ...(jwtExpiredHandling && { jwtExpiredHandling }),
    }
}

// Only top-level navigations can follow a redirect to sign-in; the guard cookie stops a redirect loop.
const canShortCircuitExpiredJwt = (request: Request): boolean =>
    request.method === 'GET' &&
    request.headers.get('Sec-Fetch-Mode') === 'navigate' &&
    parse(request.headers.get('Cookie') || '')[JWT_REFRESH_GUARD_COOKIE] === undefined

const handleJwtExpired = async (
    ctx: PipelineContext,
    request: Request,
    http: ModifyHttpResponse | undefined,
    onJwtExpired: MOSProxyJwtExpiredHandler | null,
): Promise<Response | null> => {
    const { config, logger } = ctx
    if (onJwtExpired) {
        try {
            const handlerResponse = await onJwtExpired({ request, config, logger, http })
            if (handlerResponse instanceof Response) {
                return handlerResponse
            }
            if (handlerResponse != null) {
                logger.log({
                    level: 'warn',
                    code: 'jwt-expired-handler-invalid',
                    message: 'onJwtExpired did not return a Response; applying the default.',
                })
            }
        } catch (error) {
            logger.log({
                level: 'warn',
                code: 'jwt-expired-handler-threw',
                message: 'onJwtExpired threw; applying the default.',
                error,
            })
        }
    }

    if (!http) {
        return null
    }

    // Discard the origin reply entirely; the API's instruction is the whole response.
    const [response] = applyHttpBehavior(new Response(null), http)
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    headers.append('Set-Cookie', JWT_REFRESH_GUARD_SET_COOKIE)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
