import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogEvent, MOSProxyLogger } from '../../src/logger'
import getSurfaceDecisions from '../../src/stages/surfaceDecisions'
import type { SurfaceDecisionResponse } from '../../src/types'
import { MockFetcher } from '../fakes/MockFetcher'

const baseConfig = {
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test_abc',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
}

const htmlResponse = (body = '<p/>') => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })

const successPayload = (overrides: Partial<SurfaceDecisionResponse> = {}): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier: 'anon-1', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped: true,
    componentBehaviors: {},
    ...overrides,
})

const unauthorizedResponse = () =>
    new Response(JSON.stringify({ status: 'error', message: 'invalid jwt', statusCode: 401 }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
    })

const createMemoryLogger = () => {
    const events: MOSProxyLogEvent[] = []
    const logger: MOSProxyLogger = {
        log(event) {
            events.push(event)
        },
    }
    const ctx: PipelineContext = {
        config: normalizeMOSConfig(baseConfig, logger),
        logger,
    }
    return { ctx, events }
}

describe('getSurfaceDecisions', () => {
    it('retries without JWT when MOS returns 401 and applies anonymous decisions', async () => {
        const { ctx, events } = createMemoryLogger()
        const apiFetcher = MockFetcher(async (req) => {
            const parsed = JSON.parse(await req.clone().text())
            if (parsed.identity.userJwt) {
                return unauthorizedResponse()
            }
            return new Response(JSON.stringify(successPayload({ surfaceBehavior: { http: { body: 'paywall' } } })), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        })

        const request = new Request('https://proxy.example.com/article', {
            headers: { Cookie: '__session=bad-jwt' },
        })

        const [response, surfaceDecisions] = await getSurfaceDecisions(ctx, request, htmlResponse(), apiFetcher, null, null)

        expect(apiFetcher.calls.length).toBe(2)
        const firstBody = JSON.parse(await apiFetcher.calls[0]!.request.clone().text())
        const secondBody = JSON.parse(await apiFetcher.calls[1]!.request.clone().text())
        expect(firstBody.identity).toEqual({ userJwt: 'bad-jwt' })
        expect(secondBody.identity).toEqual({ createAnonymousIdentifier: true })
        expect(surfaceDecisions?.surfaceBehavior.http?.body).toBe('paywall')
        expect(response.headers.getSetCookie()).toContain('__session=; Path=/; Max-Age=0')
        expect(events).toContainEqual(
            expect.objectContaining({
                level: 'warn',
                code: 'surface-decisions-jwt-rejected',
            }),
        )
    })

    it('retries with the anonymous cookie when both identity cookies are present', async () => {
        const { ctx } = createMemoryLogger()
        const apiFetcher = MockFetcher(async (req) => {
            const body = JSON.parse(await req.clone().text())
            if ('userJwt' in body.identity) {
                return unauthorizedResponse()
            }
            return new Response(JSON.stringify(successPayload()), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        })

        await getSurfaceDecisions(
            ctx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: 'anon-session=anon-abc; __session=bad-jwt' },
            }),
            htmlResponse(),
            apiFetcher,
            null,
            null,
        )

        const secondBody = JSON.parse(await apiFetcher.calls[1]!.request.clone().text())
        expect(secondBody.identity).toEqual({ anonymousIdentifier: 'anon-abc' })
    })

    it('sets an anonymous session cookie when the retry creates a new anonymous identity', async () => {
        const { ctx } = createMemoryLogger()
        const apiFetcher = MockFetcher(async (req) => {
            const body = JSON.parse(await req.clone().text())
            if ('userJwt' in body.identity) {
                return unauthorizedResponse()
            }
            return new Response(
                JSON.stringify(
                    successPayload({
                        identity: { identifier: 'anon-new', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
                    }),
                ),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
        })

        const [response] = await getSurfaceDecisions(
            ctx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: '__session=bad-jwt' },
            }),
            htmlResponse(),
            apiFetcher,
            null,
            null,
        )

        expect(response.headers.getSetCookie()).toContain('anon-session=anon-new; Path=/')
    })

    it('fails open when JWT is rejected and the anonymous retry also fails', async () => {
        const { ctx, events } = createMemoryLogger()
        const apiFetcher = MockFetcher(async (req) => {
            const body = JSON.parse(await req.clone().text())
            if ('userJwt' in body.identity) {
                return unauthorizedResponse()
            }
            return new Response(JSON.stringify({ unrelated: true }), { status: 503 })
        })

        const origin = htmlResponse('<p>origin</p>')
        const [response, surfaceDecisions] = await getSurfaceDecisions(
            ctx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: '__session=bad-jwt' },
            }),
            origin,
            apiFetcher,
            null,
            null,
        )

        expect(surfaceDecisions).toBeNull()
        expect(await response.text()).toBe('<p>origin</p>')
        expect(apiFetcher.calls.length).toBe(2)
        expect(events).toContainEqual(
            expect.objectContaining({
                code: 'surface-decisions-api-failed',
                context: expect.objectContaining({ retriedAsAnonymous: true }),
            }),
        )
    })

    it('does not retry when MOS returns 401 without a user JWT', async () => {
        const { ctx } = createMemoryLogger()
        const apiFetcher = MockFetcher(() => unauthorizedResponse())

        const [, surfaceDecisions] = await getSurfaceDecisions(
            ctx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: 'anon-session=anon-abc' },
            }),
            htmlResponse(),
            apiFetcher,
            null,
            null,
        )

        expect(surfaceDecisions).toBeNull()
        expect(apiFetcher.calls.length).toBe(1)
    })

    it('does not retry for non-401 API failures', async () => {
        const { ctx } = createMemoryLogger()
        const apiFetcher = MockFetcher(() => new Response(JSON.stringify({ unrelated: true }), { status: 503 }))

        const [, surfaceDecisions] = await getSurfaceDecisions(
            ctx,
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: '__session=jwt-token' },
            }),
            htmlResponse(),
            apiFetcher,
            null,
            null,
        )

        expect(surfaceDecisions).toBeNull()
        expect(apiFetcher.calls.length).toBe(1)
    })
})
