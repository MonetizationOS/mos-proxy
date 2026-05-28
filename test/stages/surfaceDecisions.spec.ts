import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import getSurfaceDecisions from '../../src/stages/surfaceDecisions'
import type { SurfaceDecisionResponse } from '../../src/types'
import { MockFetcher } from '../fakes/MockFetcher'

const silentLogger: MOSProxyLogger = { log() {} }

const baseConfigInput = {
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test_abc',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
}

const htmlResponse = () => new Response('<p/>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })

const successPayload = (overrides: Partial<SurfaceDecisionResponse> = {}): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier: 'anon-from-api', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped: true,
    componentBehaviors: {},
    ...overrides,
})

const ctx = (configOverrides: { createAnonymousIdentifierFallback?: boolean } = {}): PipelineContext => ({
    config: normalizeMOSConfig({ ...baseConfigInput, ...configOverrides }, silentLogger),
    logger: silentLogger,
})

const anonymousCookie = (identifier: string) => `anon-session=${identifier}; Path=/`

const run = async (pipelineCtx: PipelineContext, request: Request, apiResponse: SurfaceDecisionResponse) => {
    const apiFetcher = MockFetcher(() => new Response(JSON.stringify(apiResponse), { status: 200 }))
    const [response] = await getSurfaceDecisions(pipelineCtx, request, htmlResponse(), apiFetcher, null, null)
    return response.headers.getSetCookie()
}

describe('getSurfaceDecisions identity cookies', () => {
    describe('sets anonymous session cookie', () => {
        it('when no identity cookies are present and the API returns an identifier', async () => {
            const cookies = await run(ctx(), new Request('https://proxy.example.com/article'), successPayload())
            expect(cookies).toContain(anonymousCookie('anon-from-api'))
        })

        it('when only a JWT cookie is present, fallback is enabled, and the API returns an unauthenticated identity', async () => {
            const cookies = await run(
                ctx(),
                new Request('https://proxy.example.com/article', {
                    headers: { Cookie: '__session=bad-jwt' },
                }),
                successPayload({
                    identity: {
                        identifier: 'anon-from-fallback',
                        isAuthenticated: false,
                        authType: 'anonymous',
                        jwtClaims: {},
                    },
                }),
            )
            expect(cookies).toContain(anonymousCookie('anon-from-fallback'))
        })
    })

    describe('does not set anonymous session cookie', () => {
        it('when an anonymous session cookie is already present', async () => {
            const cookies = await run(
                ctx(),
                new Request('https://proxy.example.com/article', {
                    headers: { Cookie: 'anon-session=existing-anon' },
                }),
                successPayload(),
            )
            expect(cookies).not.toContain(anonymousCookie('anon-from-api'))
            expect(cookies).toEqual([])
        })

        it('when only a JWT cookie is present and the API returns an authenticated identity', async () => {
            const cookies = await run(
                ctx(),
                new Request('https://proxy.example.com/article', {
                    headers: { Cookie: '__session=valid-jwt' },
                }),
                successPayload({
                    identity: {
                        identifier: 'user-123',
                        isAuthenticated: true,
                        authType: 'jwt',
                        jwtClaims: { sub: 'user-123' },
                    },
                }),
            )
            expect(cookies).toEqual([])
        })

        it('when only a JWT cookie is present, fallback is disabled, and the API returns an unauthenticated identity', async () => {
            const cookies = await run(
                ctx({ createAnonymousIdentifierFallback: false }),
                new Request('https://proxy.example.com/article', {
                    headers: { Cookie: '__session=bad-jwt' },
                }),
                successPayload({
                    identity: {
                        identifier: 'anon-from-fallback',
                        isAuthenticated: false,
                        authType: 'anonymous',
                        jwtClaims: {},
                    },
                }),
            )
            expect(cookies).toEqual([])
        })

        it('when both identity cookies are present even if the API returns an identifier', async () => {
            const cookies = await run(
                ctx(),
                new Request('https://proxy.example.com/article', {
                    headers: { Cookie: 'anon-session=existing-anon; __session=jwt-token' },
                }),
                successPayload(),
            )
            expect(cookies).toEqual([])
        })

        it('when both identity cookies are present and JWT fallback returns an unauthenticated identity', async () => {
            const cookies = await run(
                ctx(),
                new Request('https://proxy.example.com/article', {
                    headers: { Cookie: 'anon-session=existing-anon; __session=bad-jwt' },
                }),
                successPayload({
                    identity: {
                        identifier: 'anon-from-fallback',
                        isAuthenticated: false,
                        authType: 'anonymous',
                        jwtClaims: {},
                    },
                }),
            )
            expect(cookies).toEqual([])
        })

        it('when the API response has no identifier', async () => {
            const cookies = await run(
                ctx(),
                new Request('https://proxy.example.com/article'),
                successPayload({
                    identity: { identifier: '', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
                }),
            )
            expect(cookies).toEqual([])
        })
    })
})
