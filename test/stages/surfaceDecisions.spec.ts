import { describe, expect, it } from 'vitest'
import type { ResourceProvider } from '../../src/adapters/ResourceProvider'
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
    const [response] = await getSurfaceDecisions(pipelineCtx, request, htmlResponse(), apiFetcher, null, null, null, null)
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

describe('getSurfaceDecisions resource provider', () => {
    const runWithResourceProvider = async (resourceProvider: ResourceProvider | null) => {
        const apiFetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))
        await getSurfaceDecisions(
            ctx(),
            new Request('https://proxy.example.com/article'),
            htmlResponse(),
            apiFetcher,
            null,
            null,
            null,
            resourceProvider,
        )
        const body = JSON.parse(await apiFetcher.calls[0]!.request.clone().text())
        return body.resource
    }

    it('defaults the resource to the request pathname and (empty) page metadata when no provider is set', async () => {
        expect(await runWithResourceProvider(null)).toEqual({ id: '/article', meta: {} })
    })

    it('merges the provider fields over the derived defaults', async () => {
        const resource = await runWithResourceProvider({
            build: () => ({ tier: 'premium' }),
        })
        expect(resource).toEqual({ id: '/article', meta: {}, tier: 'premium' })
    })

    it('lets the provider override the default id and meta', async () => {
        const resource = await runWithResourceProvider({
            build: () => ({ id: 'canonical-id', meta: { lang: 'en' } }),
        })
        expect(resource).toEqual({ id: 'canonical-id', meta: { lang: 'en' } })
    })
})

describe('getSurfaceDecisions request cookies', () => {
    it('forwards matching request cookies in the surface-decisions http payload', async () => {
        const apiFetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))
        const pipelineCtx: PipelineContext = {
            config: normalizeMOSConfig(
                {
                    ...baseConfigInput,
                    surfaceDecisionsCookies: '^__session$, ^theme$',
                },
                silentLogger,
            ),
            logger: silentLogger,
        }

        await getSurfaceDecisions(
            pipelineCtx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: '__session=jwt-token; theme=dark; ignored=1' },
            }),
            htmlResponse(),
            apiFetcher,
            null,
            null,
            null,
            null,
        )

        const body = JSON.parse(await apiFetcher.calls[0]!.request.clone().text())
        expect(body.http.cookies).toEqual({
            __session: 'jwt-token',
            theme: 'dark',
        })
    })

    it('forwards matching origin Set-Cookie values when the request has no Cookie header', async () => {
        const apiFetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))
        const pipelineCtx: PipelineContext = {
            config: normalizeMOSConfig(
                {
                    ...baseConfigInput,
                    surfaceDecisionsCookies: '^theme$',
                },
                silentLogger,
            ),
            logger: silentLogger,
        }

        await getSurfaceDecisions(
            pipelineCtx,
            new Request('https://proxy.example.com/article'),
            new Response('<p/>', {
                status: 200,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Set-Cookie': 'theme=dark; Path=/',
                },
            }),
            apiFetcher,
            null,
            null,
            null,
            null,
        )

        const body = JSON.parse(await apiFetcher.calls[0]!.request.clone().text())
        expect(body.http.cookies).toEqual({
            theme: 'dark',
        })
    })

    it('forwards matching origin Set-Cookie values on a client request that also sends cookies', async () => {
        const apiFetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))
        const pipelineCtx: PipelineContext = {
            config: normalizeMOSConfig(
                {
                    ...baseConfigInput,
                    surfaceDecisionsCookies: '^__session$, ^theme$',
                },
                silentLogger,
            ),
            logger: silentLogger,
        }
        const originResponse = new Response('<p/>', {
            status: 200,
            headers: new Headers([
                ['Content-Type', 'text/html; charset=utf-8'],
                ['Set-Cookie', 'theme=from-origin; Path=/'],
            ]),
        })

        await getSurfaceDecisions(
            pipelineCtx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: '__session=from-request; theme=old; ignored=1' },
            }),
            originResponse,
            apiFetcher,
            null,
            null,
            null,
            null,
        )

        const body = JSON.parse(await apiFetcher.calls[0]!.request.clone().text())
        expect(body.http.cookies).toEqual({
            __session: 'from-request',
            theme: 'from-origin',
        })
    })

    it('omits http.cookies when no patterns are configured', async () => {
        const apiFetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))

        await getSurfaceDecisions(
            ctx(),
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: '__session=jwt-token' },
            }),
            htmlResponse(),
            apiFetcher,
            null,
            null,
            null,
            null,
        )

        const body = JSON.parse(await apiFetcher.calls[0]!.request.clone().text())
        expect(body.http.cookies).toBeUndefined()
    })

    it('omits http.cookies when patterns are configured but none match', async () => {
        const apiFetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))
        const pipelineCtx: PipelineContext = {
            config: normalizeMOSConfig(
                {
                    ...baseConfigInput,
                    surfaceDecisionsCookies: '^__session$',
                },
                silentLogger,
            ),
            logger: silentLogger,
        }

        await getSurfaceDecisions(
            pipelineCtx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: 'other=1' },
            }),
            htmlResponse(),
            apiFetcher,
            null,
            null,
            null,
            null,
        )

        const body = JSON.parse(await apiFetcher.calls[0]!.request.clone().text())
        expect(body.http.cookies).toBeUndefined()
    })
})
