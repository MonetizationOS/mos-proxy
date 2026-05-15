import { describe, expect, it } from 'vitest'
import type { ElementHandlers, HtmlRewriterAdapter, HtmlRewriterCapabilities, HtmlRewriterSession } from '../src/adapters'
import { MOSProxyBuilder } from '../src/index'
import type { MOSProxyLogEvent } from '../src/logger'
import type { MOSConfigInput, SurfaceDecisionResponse } from '../src/types'
import { MockFetcher } from './fakes/MockFetcher'
import { PassthroughHtmlRewriter } from './fakes/PassthroughHtmlRewriter'

const baseConfig: MOSConfigInput = {
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test_abc',
    mosEndpointsPrefix: '/mos-endpoints/',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
}

const htmlResponse = (body: string, init: ResponseInit = {}) =>
    new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init.headers ?? {}) } })

const decisionsResponse = (overrides: Partial<SurfaceDecisionResponse> = {}): Response =>
    new Response(
        JSON.stringify({
            status: 'success',
            identity: { identifier: 'anon-abc', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
            features: {},
            customer: { hasProducts: false },
            surfaceBehavior: {},
            componentsSkipped: true,
            componentBehaviors: {},
            ...overrides,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

const createMemoryLogger = () => {
    const events: MOSProxyLogEvent[] = []
    return {
        events,
        logger: {
            log(event: MOSProxyLogEvent) {
                events.push(event)
            },
        },
    }
}

class TransformSequenceHtmlRewriter implements HtmlRewriterAdapter {
    readonly capabilities: HtmlRewriterCapabilities = { onEndTag: true, nthChild: true }
    private transformCount = 0

    constructor(private readonly throwOnTransformCount: number) {}

    create(): HtmlRewriterSession {
        return new TransformSequenceSession(() => {
            this.transformCount++
            if (this.transformCount === this.throwOnTransformCount) {
                throw new Error('html transform failed')
            }
        })
    }
}

class TransformSequenceSession implements HtmlRewriterSession {
    constructor(private readonly beforeTransform: () => void) {}

    on(_selector: string, _handlers: ElementHandlers): this {
        return this
    }

    transform(response: Response): Response {
        this.beforeTransform()
        return response
    }
}

describe('MOSProxy pipeline', () => {
    it('proxies GET requests through the origin fetcher and returns its response', async () => {
        const originFetcher = MockFetcher((req) => {
            expect(req.url).toBe('https://origin.example.com/article')
            return new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } })
        })
        const apiFetcher = MockFetcher(() => new Response(null, { status: 500 }))

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))

        expect(response.status).toBe(200)
        expect(await response.text()).toBe('hello')
        expect(originFetcher.calls.length).toBe(1)
        expect(apiFetcher.calls.length).toBe(0) // non-HTML short-circuits the pipeline
    })

    it('routes /mos-endpoints/ traffic through the API fetcher', async () => {
        const originFetcher = MockFetcher(() => new Response(null, { status: 500 }))
        const apiFetcher = MockFetcher((req) => {
            expect(req.url).toBe('https://api.monetizationos.com/api/v1/envs/env_test/endpoints/hello')
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        })

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/mos-endpoints/hello'))

        expect(response.status).toBe(200)
        expect(apiFetcher.calls.length).toBe(1)
        expect(originFetcher.calls.length).toBe(0)
    })

    it('auto-skips HTML pipeline for non-HTML origin responses', async () => {
        const originFetcher = MockFetcher(() => new Response('{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
        const apiFetcher = MockFetcher(() => decisionsResponse())

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        await proxy.handle(new Request('https://proxy.example.com/data.json'))
        expect(apiFetcher.calls.length).toBe(0)
    })

    it('rewrites origin links and calls surface-decisions API for HTML responses', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('<a href="https://origin.example.com/other">x</a>', { status: 200 }))
        const apiFetcher = MockFetcher((req) => {
            if (req.url.endsWith('/surface-decisions')) {
                return decisionsResponse()
            }
            return new Response(null, { status: 404 })
        })

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))

        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).toBe('<a href="https://proxy.example.com/other">x</a>')
        expect(apiFetcher.calls.length).toBe(1)
        expect(apiFetcher.calls[0]?.request.url).toBe('https://api.monetizationos.com/api/v1/surface-decisions')
    })

    it('sets anonymous session cookie when MOS issues one', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('<p/>', { status: 200 }))
        const apiFetcher = MockFetcher(() =>
            decisionsResponse({
                identity: { identifier: 'anon-xyz', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
            }),
        )

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))
        expect(response.headers.getSetCookie()).toContain('anon-session=anon-xyz; Path=/')
    })

    it('prefers authenticated identity when both identity cookies are present', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('<p/>', { status: 200 }))
        const apiFetcher = MockFetcher(() => decisionsResponse())

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        await proxy.handle(
            new Request('https://proxy.example.com/article', {
                headers: { Cookie: 'anon-session=anon-abc; __session=jwt-token' },
            }),
        )

        const sent = apiFetcher.calls[0]?.request
        expect(sent).toBeDefined()
        const payload = JSON.parse(await sent!.clone().text())
        expect(payload.identity).toEqual({ userJwt: 'jwt-token' })
    })

    it('skips surface decisions when path matches ignore patterns', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('<p/>', { status: 200 }))
        const apiFetcher = MockFetcher(() => decisionsResponse())

        const proxy = new MOSProxyBuilder()
            .withConfig({ ...baseConfig, surfaceDecisionsIgnorePaths: '^/health' })
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        await proxy.handle(new Request('https://proxy.example.com/health'))
        expect(apiFetcher.calls.length).toBe(0)
    })

    it('skips surface decisions for redirect responses', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('', { status: 302, headers: { Location: 'https://origin.example.com/new' } }))
        const apiFetcher = MockFetcher(() => decisionsResponse())

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        await proxy.handle(new Request('https://proxy.example.com/old'))
        expect(apiFetcher.calls.length).toBe(0)
    })

    it('applies surface-behavior status overrides', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('<p/>', { status: 200 }))
        const apiFetcher = MockFetcher(() =>
            decisionsResponse({
                surfaceBehavior: { http: { status: 402 } },
            }),
        )

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))
        expect(response.status).toBe(402)
    })

    it('spreads client metadata from the provider into the surface decisions body', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('<p/>', { status: 200 }))
        const apiFetcher = MockFetcher(() => decisionsResponse())

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .withClientMetadata({ build: () => ({ fastly: { client: { geo: { country_code: 'US' } } } }) })
            .build()

        await proxy.handle(new Request('https://proxy.example.com/article'))
        const sent = apiFetcher.calls[0]?.request
        expect(sent).toBeDefined()
        const payload = JSON.parse(await sent!.clone().text())
        expect(payload.fastly).toEqual({ client: { geo: { country_code: 'US' } } })
        expect(payload.cloudflare).toBeUndefined()
    })

    it('fails open for surface decisions API failures and returns the rewritten response', async () => {
        const { events, logger } = createMemoryLogger()
        const originFetcher = MockFetcher(() => htmlResponse('<a href="https://origin.example.com/other">x</a>', { status: 200 }))
        const apiFetcher = MockFetcher(() => {
            throw new Error('api unavailable')
        })

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new PassthroughHtmlRewriter())
            .withLogger(logger)
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))

        expect(await response.text()).toBe('<a href="https://proxy.example.com/other">x</a>')
        expect(events).toContainEqual(
            expect.objectContaining({
                level: 'warn',
                code: 'surface-decisions-api-failed',
                context: expect.objectContaining({ reason: 'request-failed' }),
            }),
        )
    })

    it('fails open with the last safe response when local HTML transformation fails', async () => {
        const { events, logger } = createMemoryLogger()
        const originFetcher = MockFetcher(() => htmlResponse('<a href="https://origin.example.com/other">x</a>', { status: 200 }))
        const apiFetcher = MockFetcher(() =>
            decisionsResponse({
                componentsSkipped: false,
                componentBehaviors: {
                    link: {
                        metadata: { cssSelector: 'a' },
                        content: { append: [{ type: 'text', content: '!' }] },
                    },
                },
                surfaceBehavior: { http: { addHeaders: [{ name: 'X-MOS', value: 'on' }] } },
            }),
        )

        const proxy = new MOSProxyBuilder()
            .withConfig({ ...baseConfig, injectScriptUrl: 'https://assets.example.com/components.js' })
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new TransformSequenceHtmlRewriter(2))
            .withLogger(logger)
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))

        expect(response.headers.get('X-MOS')).toBe('on')
        expect(await response.text()).toBe('<a href="https://proxy.example.com/other">x</a>')
        expect(events).toContainEqual(
            expect.objectContaining({
                level: 'error',
                code: 'html-pipeline-failed',
                context: expect.objectContaining({ stage: 'surface-components', hasErrorHandler: false }),
            }),
        )
    })

    it('routes HTML pipeline failures through onHtmlPipelineError when provided', async () => {
        const { events, logger } = createMemoryLogger()
        const originFetcher = MockFetcher(() => htmlResponse('<p/>', { status: 200 }))
        const apiFetcher = MockFetcher(() =>
            decisionsResponse({
                componentsSkipped: false,
                componentBehaviors: {
                    paragraph: {
                        metadata: { cssSelector: 'p' },
                        content: { append: [{ type: 'text', content: '!' }] },
                    },
                },
            }),
        )

        let handlerCalls = 0
        const proxy = new MOSProxyBuilder()
            .withConfig({ ...baseConfig, injectScriptUrl: 'https://assets.example.com/components.js' })
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new TransformSequenceHtmlRewriter(2))
            .withLogger(logger)
            .withHtmlPipelineErrorHandler(({ error, stage }) => {
                handlerCalls += 1
                return new Response(`pipeline failed at ${stage}: ${(error as Error).message}`, { status: 503 })
            })
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))

        expect(handlerCalls).toBe(1)
        expect(response.status).toBe(503)
        expect(await response.text()).toBe('pipeline failed at surface-components: html transform failed')
        expect(events).toContainEqual(
            expect.objectContaining({
                level: 'error',
                code: 'html-pipeline-failed',
                context: expect.objectContaining({ stage: 'surface-components', hasErrorHandler: true }),
            }),
        )
    })

    it('falls back to the last safe response when the error handler throws', async () => {
        const { events, logger } = createMemoryLogger()
        const originFetcher = MockFetcher(() => htmlResponse('<a href="https://origin.example.com/other">x</a>', { status: 200 }))
        const apiFetcher = MockFetcher(() =>
            decisionsResponse({
                componentsSkipped: false,
                componentBehaviors: {
                    link: {
                        metadata: { cssSelector: 'a' },
                        content: { append: [{ type: 'text', content: '!' }] },
                    },
                },
                surfaceBehavior: { http: { addHeaders: [{ name: 'X-MOS', value: 'on' }] } },
            }),
        )

        const proxy = new MOSProxyBuilder()
            .withConfig({ ...baseConfig, injectScriptUrl: 'https://assets.example.com/components.js' })
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withHtmlRewriter(new TransformSequenceHtmlRewriter(2))
            .withLogger(logger)
            .withHtmlPipelineErrorHandler(() => {
                throw new Error('handler boom')
            })
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))

        expect(response.headers.get('X-MOS')).toBe('on')
        expect(await response.text()).toBe('<a href="https://proxy.example.com/other">x</a>')
        expect(events).toContainEqual(
            expect.objectContaining({
                level: 'warn',
                code: 'html-pipeline-error-handler-threw',
                context: expect.objectContaining({ stage: 'surface-components' }),
            }),
        )
    })
})

describe('MOSProxy API-only mode (withoutHtmlTransformation)', () => {
    it('bypasses the HTML pipeline and does not require an HTML rewriter', async () => {
        const originFetcher = MockFetcher(() => htmlResponse('<a href="https://origin.example.com/x">x</a>', { status: 200 }))
        const apiFetcher = MockFetcher(() => new Response(null, { status: 500 }))

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withApiFetcher(apiFetcher)
            .withoutHtmlTransformation()
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/article'))
        expect(await response.text()).toBe('<a href="https://origin.example.com/x">x</a>')
        expect(apiFetcher.calls.length).toBe(0)
    })

    it('allows omitting API fetcher when custom endpoints, surface decisions, and HTML transformation are all disabled', async () => {
        const originFetcher = MockFetcher(() => new Response('ok', { status: 200 }))

        const proxy = new MOSProxyBuilder()
            .withConfig(baseConfig)
            .withOriginFetcher(originFetcher)
            .withoutCustomEndpoints()
            .withoutSurfaceDecisions()
            .withoutHtmlTransformation()
            .build()

        const response = await proxy.handle(new Request('https://proxy.example.com/api/v1/thing'))
        expect(await response.text()).toBe('ok')
    })
})

describe('MOSProxyBuilder validation', () => {
    it('requires config', () => {
        expect(() => new MOSProxyBuilder().withOriginFetcher(MockFetcher(() => new Response(null))).build()).toThrow(/withConfig/)
    })

    it('requires an HTML rewriter when surface decisions are enabled', () => {
        expect(() =>
            new MOSProxyBuilder()
                .withConfig(baseConfig)
                .withOriginFetcher(MockFetcher(() => new Response(null)))
                .withApiFetcher(MockFetcher(() => new Response(null)))
                .build(),
        ).toThrow(/withHtmlRewriter/)
    })
})
