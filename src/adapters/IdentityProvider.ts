import { parse, parseSetCookie } from 'cookie'
import type { MOSConfig } from '../config'
import type { MOSProxyLogger } from '../logger'
import type { SurfaceDecisionResponse } from '../types'

export type Identity =
    | { createAnonymousIdentifier: true }
    | { userJwt: string; createAnonymousIdentifierFallback?: true }
    | { anonymousIdentifier: string }

export interface ResolveIdentityArgs {
    request: Request
    originResponse?: Response
    config: MOSConfig
    logger: MOSProxyLogger
}

export interface PersistIdentityArgs {
    resolved: Identity
    decisions: SurfaceDecisionResponse
    response: Response
    request: Request
    config: MOSConfig
    logger: MOSProxyLogger
}

/**
 * Either method is optional; omitted methods use the built-in defaults. Both fail open: a throwing
 * `resolve` skips surface decisions; a throwing `persist` keeps the pre-persist response.
 */
export interface IdentityProvider {
    resolve?(args: ResolveIdentityArgs): Identity | Promise<Identity>
    persist?(args: PersistIdentityArgs): Response | Promise<Response>
}

export const getExistingCookies = (
    request: Request,
    originResponse: Response | undefined,
    config: MOSConfig,
): { anonymousIdentifier?: string; userJwt?: string } => {
    const setCookies = originResponse?.headers.getSetCookie().map((header) => parseSetCookie(header)) || []
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

export const buildIdentity = ({
    anonymousIdentifier,
    userJwt,
    createAnonymousIdentifierFallback = false,
}: {
    anonymousIdentifier?: string
    userJwt?: string
    createAnonymousIdentifierFallback?: boolean
}): Identity => {
    if (userJwt) {
        return createAnonymousIdentifierFallback ? { userJwt, createAnonymousIdentifierFallback: true } : { userJwt }
    }

    if (anonymousIdentifier) {
        return { anonymousIdentifier }
    }

    return { createAnonymousIdentifier: true }
}

export const defaultResolveIdentity = (args: ResolveIdentityArgs): Identity =>
    buildIdentity({
        ...getExistingCookies(args.request, args.originResponse, args.config),
        createAnonymousIdentifierFallback: args.config.createAnonymousIdentifierFallback,
    })

export const defaultPersistIdentity = (args: PersistIdentityArgs): Response => {
    const { resolved, decisions, response, request, config } = args
    const identifier = decisions.identity?.identifier
    if (!identifier) {
        return response
    }

    const minted = 'createAnonymousIdentifier' in resolved && resolved.createAnonymousIdentifier === true
    // A JWT resolved with the fallback flag mints a fresh anonymous identifier only when the API reports the
    // JWT as unauthenticated, and only when the request did not already carry an anonymous session cookie.
    const jwtFallback =
        'createAnonymousIdentifierFallback' in resolved &&
        resolved.createAnonymousIdentifierFallback === true &&
        !decisions.identity?.isAuthenticated &&
        !getExistingCookies(request, response, config).anonymousIdentifier

    if (!minted && !jwtFallback) {
        return response
    }

    const headers = new Headers(response.headers)
    headers.append('Set-Cookie', `${config.anonymousSessionCookieName}=${identifier}; Path=/`)
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}
