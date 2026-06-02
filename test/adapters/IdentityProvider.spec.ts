import { describe, expect, it } from 'vitest'
import { buildIdentity, defaultPersistIdentity, defaultResolveIdentity, getExistingCookies } from '../../src/adapters/IdentityProvider'
import { normalizeMOSConfig } from '../../src/config'
import type { MOSProxyLogger } from '../../src/logger'
import type { SurfaceDecisionResponse } from '../../src/types'

const silentLogger: MOSProxyLogger = { log() {} }

const config = normalizeMOSConfig({
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test_abc',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
})

const decisions = (identifier = 'anon-from-api'): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier, isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped: true,
    componentBehaviors: {},
})

describe('getExistingCookies', () => {
    it('prefers origin Set-Cookie values over request Cookie header', () => {
        const request = new Request('https://proxy.example.com/article', {
            headers: { Cookie: 'anon-session=req-anon; __session=req-jwt' },
        })
        const originResponse = new Response(null, {
            headers: [
                ['Set-Cookie', 'anon-session=origin-anon; Path=/'],
                ['Set-Cookie', '__session=origin-jwt; Path=/'],
            ],
        })

        expect(getExistingCookies(request, originResponse, config)).toEqual({
            anonymousIdentifier: 'origin-anon',
            userJwt: 'origin-jwt',
        })
    })

    it('falls back to request Cookie header when origin has no identity Set-Cookies', () => {
        const request = new Request('https://proxy.example.com/article', {
            headers: { Cookie: 'anon-session=req-anon; __session=req-jwt' },
        })
        const originResponse = new Response(null)

        expect(getExistingCookies(request, originResponse, config)).toEqual({
            anonymousIdentifier: 'req-anon',
            userJwt: 'req-jwt',
        })
    })

    it('returns undefined values when no cookies are present anywhere', () => {
        const request = new Request('https://proxy.example.com/article')
        const originResponse = new Response(null)

        expect(getExistingCookies(request, originResponse, config)).toEqual({
            anonymousIdentifier: undefined,
            userJwt: undefined,
        })
    })
})

describe('buildIdentity', () => {
    it('returns createAnonymousIdentifier when neither value is present', () => {
        expect(buildIdentity({})).toEqual({ createAnonymousIdentifier: true })
    })

    it('returns userJwt when both values are present (JWT wins)', () => {
        expect(buildIdentity({ anonymousIdentifier: 'a', userJwt: 'j' })).toEqual({ userJwt: 'j' })
    })

    it('returns anonymousIdentifier when only the anonymous value is present', () => {
        expect(buildIdentity({ anonymousIdentifier: 'a' })).toEqual({ anonymousIdentifier: 'a' })
    })

    it('flags the JWT for anonymous fallback when the fallback option is enabled', () => {
        expect(buildIdentity({ userJwt: 'j', createAnonymousIdentifierFallback: true })).toEqual({
            userJwt: 'j',
            createAnonymousIdentifierFallback: true,
        })
    })

    it('keeps JWT precedence and the fallback flag when both values are present', () => {
        expect(buildIdentity({ anonymousIdentifier: 'a', userJwt: 'j', createAnonymousIdentifierFallback: true })).toEqual({
            userJwt: 'j',
            createAnonymousIdentifierFallback: true,
        })
    })

    it('ignores the fallback option for anonymous identity (no JWT)', () => {
        expect(buildIdentity({ anonymousIdentifier: 'a', createAnonymousIdentifierFallback: true })).toEqual({ anonymousIdentifier: 'a' })
    })
})

describe('defaultResolveIdentity', () => {
    it('composes getExistingCookies and buildIdentity (anonymous from request cookie)', async () => {
        const request = new Request('https://proxy.example.com/article', {
            headers: { Cookie: 'anon-session=abc' },
        })
        const originResponse = new Response(null)

        const identity = await defaultResolveIdentity({ request, originResponse, config, logger: silentLogger })
        expect(identity).toEqual({ anonymousIdentifier: 'abc' })
    })

    it('asks the API to mint an anonymous identifier when no cookies exist', async () => {
        const request = new Request('https://proxy.example.com/article')
        const originResponse = new Response(null)

        const identity = await defaultResolveIdentity({ request, originResponse, config, logger: silentLogger })
        expect(identity).toEqual({ createAnonymousIdentifier: true })
    })

    it('flags the JWT for anonymous fallback by default', async () => {
        const request = new Request('https://proxy.example.com/article', {
            headers: { Cookie: '__session=jwt-token' },
        })
        const originResponse = new Response(null)

        const identity = await defaultResolveIdentity({ request, originResponse, config, logger: silentLogger })
        expect(identity).toEqual({ userJwt: 'jwt-token', createAnonymousIdentifierFallback: true })
    })

    it('omits the fallback flag when the option is disabled', async () => {
        const noFallbackConfig = normalizeMOSConfig({
            originUrl: 'https://origin.example.com',
            surfaceSlug: 'web',
            mosHost: 'https://api.monetizationos.com',
            mosSecretKey: 'sk_env_test_abc',
            anonymousSessionCookieName: 'anon-session',
            authenticatedUserJwtCookieName: '__session',
            createAnonymousIdentifierFallback: false,
        })
        const request = new Request('https://proxy.example.com/article', {
            headers: { Cookie: '__session=jwt-token' },
        })
        const originResponse = new Response(null)

        const identity = await defaultResolveIdentity({ request, originResponse, config: noFallbackConfig, logger: silentLogger })
        expect(identity).toEqual({ userJwt: 'jwt-token' })
    })
})

describe('defaultPersistIdentity', () => {
    it('appends Set-Cookie when the resolved identity asked the API to mint one and the API returned an identifier', async () => {
        const response = new Response('body', { status: 200 })

        const updated = await defaultPersistIdentity({
            resolved: { createAnonymousIdentifier: true },
            decisions: decisions('anon-from-api'),
            response,
            request: new Request('https://proxy.example.com/article'),
            config,
            logger: silentLogger,
        })

        expect(updated.headers.getSetCookie()).toContain('anon-session=anon-from-api; Path=/')
        expect(await updated.text()).toBe('body')
    })

    it('does nothing when the resolved identity already had an anonymousIdentifier', async () => {
        const response = new Response('body', { status: 200 })

        const updated = await defaultPersistIdentity({
            resolved: { anonymousIdentifier: 'existing' },
            decisions: decisions('anon-from-api'),
            response,
            request: new Request('https://proxy.example.com/article'),
            config,
            logger: silentLogger,
        })

        expect(updated).toBe(response)
        expect(updated.headers.getSetCookie()).toEqual([])
    })

    it('does nothing when the resolved identity was a userJwt', async () => {
        const response = new Response('body', { status: 200 })

        const updated = await defaultPersistIdentity({
            resolved: { userJwt: 'jwt' },
            decisions: decisions('anon-from-api'),
            response,
            request: new Request('https://proxy.example.com/article'),
            config,
            logger: silentLogger,
        })

        expect(updated).toBe(response)
        expect(updated.headers.getSetCookie()).toEqual([])
    })

    it('mints an anonymous cookie when a JWT fallback resolves to an unauthenticated identity', async () => {
        const response = new Response('body', { status: 200 })

        const updated = await defaultPersistIdentity({
            resolved: { userJwt: 'bad-jwt', createAnonymousIdentifierFallback: true },
            decisions: decisions('anon-from-fallback'),
            response,
            request: new Request('https://proxy.example.com/article', { headers: { Cookie: '__session=bad-jwt' } }),
            config,
            logger: silentLogger,
        })

        expect(updated.headers.getSetCookie()).toContain('anon-session=anon-from-fallback; Path=/')
        expect(await updated.text()).toBe('body')
    })

    it('does nothing when a JWT fallback resolves to an authenticated identity', async () => {
        const response = new Response('body', { status: 200 })

        const updated = await defaultPersistIdentity({
            resolved: { userJwt: 'good-jwt', createAnonymousIdentifierFallback: true },
            decisions: {
                ...decisions('user-123'),
                identity: { identifier: 'user-123', isAuthenticated: true, authType: 'jwt', jwtClaims: { sub: 'user-123' } },
            },
            response,
            request: new Request('https://proxy.example.com/article', { headers: { Cookie: '__session=good-jwt' } }),
            config,
            logger: silentLogger,
        })

        expect(updated).toBe(response)
        expect(updated.headers.getSetCookie()).toEqual([])
    })

    it('does not overwrite an existing anonymous cookie under JWT fallback', async () => {
        const response = new Response('body', { status: 200 })

        const updated = await defaultPersistIdentity({
            resolved: { userJwt: 'bad-jwt', createAnonymousIdentifierFallback: true },
            decisions: decisions('anon-from-fallback'),
            response,
            request: new Request('https://proxy.example.com/article', {
                headers: { Cookie: 'anon-session=existing-anon; __session=bad-jwt' },
            }),
            config,
            logger: silentLogger,
        })

        expect(updated).toBe(response)
        expect(updated.headers.getSetCookie()).toEqual([])
    })
})
