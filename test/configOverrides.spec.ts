import { describe, expect, it } from 'vitest'
import { ConfigUnresolvableError, hostPathMatcher, MOSProxyBuilder } from '../src/index'
import type { MOSConfigInput } from '../src/types'
import { createMemoryLogger } from './fakes/MemoryLogger'
import { MockFetcher } from './fakes/MockFetcher'

const baseConfig: MOSConfigInput = {
    originUrl: 'https://base-origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test',
    mosEndpointsPrefix: '/mos-endpoints/',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
}

const newsConfig: MOSConfigInput = { ...baseConfig, originUrl: 'https://news-origin.example.com' }

const textResponse = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } })

/** Minimal HTML-pipeline-free proxy: just routes to the origin so we can observe the resolved origin. */
const routingProxy = (build: (b: MOSProxyBuilder) => MOSProxyBuilder, originFetcher = MockFetcher(() => textResponse('ok'))) =>
    build(
        new MOSProxyBuilder().withConfig(baseConfig).withOriginFetcher(originFetcher).withoutCustomEndpoints().withoutSurfaceDecisions(),
    ).build()

describe('per-request config overrides', () => {
    it('rejects a non-positive-integer cache size at build time', () => {
        expect(() => routingProxy((b) => b.withConfigCacheSize(0))).toThrow(/maxCachedConfigs must be a positive integer/)
    })

    it('uses the static config and never re-normalizes when no factory is configured', async () => {
        const originFetcher = MockFetcher((req) => {
            expect(new URL(req.url).host).toBe('base-origin.example.com')
            return textResponse('ok')
        })
        const proxy = routingProxy((b) => b, originFetcher)

        const res = await proxy.handle(new Request('https://acme.com/article'))

        expect(await res.text()).toBe('ok')
        expect(originFetcher.calls).toHaveLength(1)
    })

    it('routes through the origin from the factory-resolved config', async () => {
        const originFetcher = MockFetcher((req) => textResponse(new URL(req.url).host))
        const proxy = routingProxy((b) => b.withConfig(hostPathMatcher([{ host: 'news.acme.com', config: newsConfig }])), originFetcher)

        const res = await proxy.handle(new Request('https://news.acme.com/article'))

        // The request pathname is preserved against the resolved origin host.
        expect(originFetcher.calls[0]!.request.url).toBe('https://news-origin.example.com/article')
        expect(await res.text()).toBe('news-origin.example.com')
    })

    it('awaits an async (KV-style) factory', async () => {
        const originFetcher = MockFetcher((req) => textResponse(new URL(req.url).host))
        const proxy = routingProxy(
            (b) =>
                b.withConfig(async (request) => {
                    await Promise.resolve()
                    return new URL(request.url).host === 'news.acme.com' ? newsConfig : baseConfig
                }),
            originFetcher,
        )

        await proxy.handle(new Request('https://news.acme.com/x'))
        expect(originFetcher.calls[0]!.request.url).toBe('https://news-origin.example.com/x')
    })

    it('re-derives mosEnvironment from the factory config (observed on the custom-endpoint route)', async () => {
        const apiFetcher = MockFetcher(() => textResponse('endpoint-ok'))
        const proxy = new MOSProxyBuilder()
            .withConfig(() => ({ ...baseConfig, mosSecretKey: 'sk_prod_xyz' }))
            .withOriginFetcher(MockFetcher(() => textResponse('origin')))
            .withApiFetcher(apiFetcher)
            .withoutSurfaceDecisions()
            .build()

        await proxy.handle(new Request('https://acme.com/mos-endpoints/foo'))

        // mosEnvironment (`sk_<env>_<suffix>`) appears in the endpoint path — proves the factory config normalized.
        expect(new URL(apiFetcher.calls[0]!.request.url).pathname).toBe('/api/v1/envs/prod_xyz/endpoints/foo')
    })

    describe('invalid factory config', () => {
        it('throws when the returned config cannot be normalized and there is no last-known-good', async () => {
            const { events, logger } = createMemoryLogger()
            const proxy = routingProxy((b) => b.withLogger(logger).withConfig(() => ({ ...baseConfig, originUrl: 'not-a-valid-url' })))

            await expect(proxy.handle(new Request('https://acme.com/x'))).rejects.toBeInstanceOf(ConfigUnresolvableError)
            expect(events.filter((e) => e.code === 'config-resolution-failed')).toHaveLength(1)
        })

        it('throws when the factory itself throws', async () => {
            const proxy = routingProxy((b) =>
                b.withConfig(() => {
                    throw new Error('factory boom')
                }),
            )

            await expect(proxy.handle(new Request('https://acme.com/x'))).rejects.toBeInstanceOf(ConfigUnresolvableError)
        })

        it('logs an invalid (un-normalizable) config only once across repeated requests to the same brand', async () => {
            const { events, logger } = createMemoryLogger()
            const proxy = routingProxy((b) => b.withLogger(logger).withConfig(() => ({ ...baseConfig, originUrl: 'not-a-valid-url' })))

            for (let i = 0; i < 5; i++) {
                await proxy.handle(new Request('https://acme.com/x')).catch(() => {})
            }

            expect(events.filter((e) => e.code === 'config-resolution-failed')).toHaveLength(1)
        })

        it('logs every time the factory throws (operational fault, not deduped)', async () => {
            const { events, logger } = createMemoryLogger()
            const proxy = routingProxy((b) =>
                b.withLogger(logger).withConfig(() => {
                    throw new Error('factory boom')
                }),
            )

            for (let i = 0; i < 3; i++) {
                await proxy.handle(new Request('https://acme.com/x')).catch(() => {})
            }

            expect(events.filter((e) => e.code === 'config-resolution-failed')).toHaveLength(3)
        })
    })

    describe('last-known-good fallback', () => {
        it('serves the last-known-good config for a host when a later resolution fails', async () => {
            let healthy = true
            const originFetcher = MockFetcher((req) => textResponse(new URL(req.url).host))
            const proxy = routingProxy(
                (b) =>
                    b.withConfig(() => {
                        if (!healthy) throw new Error('brand store down')
                        return newsConfig
                    }),
                originFetcher,
            )

            await proxy.handle(new Request('https://news.acme.com/first'))
            expect(originFetcher.calls[0]!.request.url).toBe('https://news-origin.example.com/first')

            healthy = false
            const res = await proxy.handle(new Request('https://news.acme.com/second'))
            expect(originFetcher.calls[1]!.request.url).toBe('https://news-origin.example.com/second')
            expect(await res.text()).toBe('news-origin.example.com')
        })

        it("does not serve one host's config to another host on failure", async () => {
            const originFetcher = MockFetcher((req) => textResponse(new URL(req.url).host))
            const proxy = routingProxy(
                (b) =>
                    b.withConfig((request) => {
                        if (new URL(request.url).hostname === 'news.acme.com') return newsConfig
                        throw new Error('unknown host')
                    }),
                originFetcher,
            )

            await proxy.handle(new Request('https://news.acme.com/x'))
            await expect(proxy.handle(new Request('https://unknown.com/x'))).rejects.toBeInstanceOf(ConfigUnresolvableError)
        })
    })

    describe('unresolved-config handler (fail closed)', () => {
        it('returns the handler response with reason invalid-config when the factory throws', async () => {
            const proxy = routingProxy((b) =>
                b
                    .withConfig(() => {
                        throw new Error('boom')
                    })
                    .withUnresolvedConfigHandler(({ reason }) => new Response(`closed:${reason}`, { status: 404 })),
            )

            const res = await proxy.handle(new Request('https://unknown.com/x'))
            expect(res.status).toBe(404)
            expect(await res.text()).toBe('closed:invalid-config')
        })

        it('returns the handler response when normalization fails', async () => {
            const proxy = routingProxy((b) =>
                b
                    .withConfig(() => ({ ...baseConfig, originUrl: 'not-a-valid-url' }))
                    .withUnresolvedConfigHandler(({ reason }) => new Response(reason, { status: 500 })),
            )

            const res = await proxy.handle(new Request('https://acme.com/x'))
            expect(res.status).toBe(500)
            expect(await res.text()).toBe('invalid-config')
        })

        it('falls through to last-known-good when the handler returns nothing', async () => {
            let healthy = true
            const originFetcher = MockFetcher((req) => textResponse(new URL(req.url).host))
            const proxy = routingProxy(
                (b) =>
                    b
                        .withConfig(() => {
                            if (!healthy) throw new Error('down')
                            return newsConfig
                        })
                        .withUnresolvedConfigHandler(() => undefined),
                originFetcher,
            )

            await proxy.handle(new Request('https://news.acme.com/x'))
            healthy = false
            const res = await proxy.handle(new Request('https://news.acme.com/y'))
            expect(await res.text()).toBe('news-origin.example.com')
        })

        it('throws when the handler returns nothing and there is no last-known-good for the host', async () => {
            const proxy = routingProxy((b) =>
                b
                    .withConfig(() => {
                        throw new Error('boom')
                    })
                    .withUnresolvedConfigHandler(() => undefined),
            )

            await expect(proxy.handle(new Request('https://unknown.com/x'))).rejects.toBeInstanceOf(ConfigUnresolvableError)
        })

        it('falls through to last-known-good and logs when the handler throws', async () => {
            let healthy = true
            const { events, logger } = createMemoryLogger()
            const originFetcher = MockFetcher((req) => textResponse(new URL(req.url).host))
            const proxy = routingProxy(
                (b) =>
                    b
                        .withLogger(logger)
                        .withConfig(() => {
                            if (!healthy) throw new Error('down')
                            return newsConfig
                        })
                        .withUnresolvedConfigHandler(() => {
                            throw new Error('handler boom')
                        }),
                originFetcher,
            )

            await proxy.handle(new Request('https://news.acme.com/x'))
            healthy = false
            const res = await proxy.handle(new Request('https://news.acme.com/y'))
            expect(await res.text()).toBe('news-origin.example.com')
            expect(events.filter((e) => e.code === 'unresolved-config-handler-threw')).toHaveLength(1)
        })
    })

    it('compiles + warns once for an invalid regex in a factory config, across repeated requests', async () => {
        const { events, logger } = createMemoryLogger()
        const originFetcher = MockFetcher(() => textResponse('ok'))
        const proxy = routingProxy(
            (b) => b.withLogger(logger).withConfig(() => ({ ...baseConfig, surfaceDecisionsIgnorePaths: '[invalid' })),
            originFetcher,
        )

        for (let i = 0; i < 5; i++) {
            await proxy.handle(new Request('https://acme.com/x'))
        }

        expect(events.filter((e) => e.code === 'invalid-ignore-path-pattern')).toHaveLength(1)
    })
})
