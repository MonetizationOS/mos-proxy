import { describe, expect, it } from 'vitest'
import { MOS_PROXY_CLIENT_HEADER, MOS_PROXY_PACKAGE_VERSION, MOS_PROXY_VERSION_HEADER } from '../../src/apiRequestHeaders'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import fetchSurfaceDecisions, { type FetchSurfaceDecisionsArgs } from '../../src/stages/fetchSurfaceDecisions'
import type { SurfaceDecisionResponse } from '../../src/types'
import { MockFetcher } from '../fakes/MockFetcher'

const silentLogger: MOSProxyLogger = { log() {} }
const ctx: PipelineContext = {
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon-session',
        authenticatedUserJwtCookieName: '__session',
    }),
    logger: silentLogger,
}

const args = (overrides: Partial<FetchSurfaceDecisionsArgs> = {}): FetchSurfaceDecisionsArgs => ({
    identity: { createAnonymousIdentifier: true },
    url: 'https://proxy.example.com/article',
    clientMetadata: {},
    resource: { id: '/article' },
    originStatus: 200,
    ...overrides,
})

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

describe('fetchSurfaceDecisions', () => {
    it('POSTs to /api/v1/surface-decisions with bearer auth and the expected payload', async () => {
        const fetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))

        const result = await fetchSurfaceDecisions(
            ctx,
            args({
                identity: { anonymousIdentifier: 'anon-abc' },
                resource: { id: '/article', meta: { description: 'd' } },
                userAgent: 'TestAgent/1.0',
                clientMetadata: { cloudflare: { cf: { country: 'US' } } },
            }),
            fetcher,
        )

        expect(result).toEqual({ ok: true, data: expect.objectContaining({ status: 'success' }) })

        const req = fetcher.calls[0]!.request
        expect(req.url).toBe('https://api.monetizationos.com/api/v1/surface-decisions')
        expect(req.method).toBe('POST')
        expect(req.headers.get('Authorization')).toBe('Bearer sk_env_test_abc')
        expect(req.headers.get('Content-Type')).toBe('application/json')
        expect(req.headers.get(MOS_PROXY_VERSION_HEADER)).toBe(MOS_PROXY_PACKAGE_VERSION)
        expect(req.headers.get(MOS_PROXY_CLIENT_HEADER)).toMatch(/^runtime=/)

        const body = JSON.parse(await req.clone().text())
        expect(body).toEqual({
            surfaceSlug: 'web',
            identity: { anonymousIdentifier: 'anon-abc' },
            resource: { id: '/article', meta: { description: 'd' } },
            http: { url: 'https://proxy.example.com/article', userAgent: 'TestAgent/1.0', proxyOrigin: { status: 200 } },
            cloudflare: { cf: { country: 'US' } },
        })
    })

    it('spreads Fastly client metadata at the top level to match the Fastly proxy shape', async () => {
        const fetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))

        await fetchSurfaceDecisions(
            ctx,
            args({
                clientMetadata: { fastly: { client: { geo: { country_code: 'US' } }, sigsci: {} } },
            }),
            fetcher,
        )

        const body = JSON.parse(await fetcher.calls[0]!.request.clone().text())
        expect(body.fastly).toEqual({ client: { geo: { country_code: 'US' } }, sigsci: {} })
        expect(body.cloudflare).toBeUndefined()
    })

    it('forwards the identity payload to the API as-is', async () => {
        const fetcher = MockFetcher(() => new Response(JSON.stringify(successPayload()), { status: 200 }))

        await fetchSurfaceDecisions(ctx, args({ identity: { userJwt: 'jwt-token' } }), fetcher)

        const body = JSON.parse(await fetcher.calls[0]!.request.clone().text())
        expect(body.identity).toEqual({ userJwt: 'jwt-token' })
    })

    it('reports request-failed when the API fetcher throws', async () => {
        const fetcher = MockFetcher(() => {
            throw new Error('network down')
        })

        const result = await fetchSurfaceDecisions(ctx, args(), fetcher)

        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason).toBe('request-failed')
            expect((result.error as Error).message).toBe('network down')
        }
    })

    it('reports invalid-json when the response body is not JSON', async () => {
        const fetcher = MockFetcher(() => new Response('not json', { status: 200 }))

        const result = await fetchSurfaceDecisions(ctx, args(), fetcher)

        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason).toBe('invalid-json')
            expect(result.status).toBe(200)
        }
    })

    it('reports api-error when the response body matches the MOS error shape', async () => {
        const fetcher = MockFetcher(
            () =>
                new Response(JSON.stringify({ status: 'error', message: 'no surface', statusCode: 404 }), {
                    status: 400,
                }),
        )

        const result = await fetchSurfaceDecisions(ctx, args(), fetcher)

        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason).toBe('api-error')
            expect((result.error as Error).message).toBe('no surface')
            expect(result.status).toBe(400)
            expect(result.statusCode).toBe(404)
        }
    })

    it('reports http-error when status is non-2xx and the body is JSON but not an error shape', async () => {
        const fetcher = MockFetcher(() => new Response(JSON.stringify({ unrelated: true }), { status: 503 }))

        const result = await fetchSurfaceDecisions(ctx, args(), fetcher)

        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason).toBe('http-error')
            expect(result.status).toBe(503)
        }
    })

    it('reports invalid-response when the JSON shape does not match the expected schema', async () => {
        const fetcher = MockFetcher(() => new Response(JSON.stringify({ status: 'success' }), { status: 200 }))

        const result = await fetchSurfaceDecisions(ctx, args(), fetcher)

        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason).toBe('invalid-response')
        }
    })
})
