import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogEvent, MOSProxyLogger } from '../../src/logger'
import handleSurfaceComponents from '../../src/stages/surfaceComponents'
import type { MOSConfigInput, SubSurfaceBehaviorApi, SurfaceDecisionResponse } from '../../src/types'
import { LolHtmlRewriter } from '../fakes/LolHtmlRewriter'

const silentLogger: MOSProxyLogger = { log() {} }
const createRecordingLogger = (): { events: MOSProxyLogEvent[]; logger: MOSProxyLogger } => {
    const events: MOSProxyLogEvent[] = []
    return { events, logger: { log: (event) => events.push(event) } }
}

const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

const rawBaseConfig: MOSConfigInput = {
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test_abc',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
}
const baseCtx: PipelineContext = { config: normalizeMOSConfig(rawBaseConfig), logger: silentLogger }
const ctxWith = (overrides: Partial<MOSConfigInput>, logger: MOSProxyLogger = silentLogger): PipelineContext => ({
    config: normalizeMOSConfig({ ...rawBaseConfig, ...overrides }),
    logger,
})
const withLogger = (logger: MOSProxyLogger): PipelineContext => ({ config: baseCtx.config, logger })

const decisions = (componentBehaviors: Record<string, SubSurfaceBehaviorApi>, componentsSkipped = false): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier: 'anon', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped,
    componentBehaviors,
})

describe('handleSurfaceComponents', () => {
    it('returns the response unchanged when componentsSkipped is true', async () => {
        const response = html('<html><head></head><body><p>hi</p></body></html>')
        const result = await handleSurfaceComponents(
            ctxWith({ injectScriptUrl: 'https://x.example/script.js' }),
            response,
            decisions({}, true),
            new LolHtmlRewriter(),
        )
        expect(result).toBe(response)
    })

    it('injects the configured script tag into <head>', async () => {
        const response = html('<html><head><title>t</title></head><body><p>body</p></body></html>')

        const result = await handleSurfaceComponents(
            ctxWith({ injectScriptUrl: 'https://assets.example.com/components.js' }),
            response,
            decisions({
                p: {
                    metadata: { cssSelector: 'p' },
                    content: { append: [{ type: 'text', content: '!' }] },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toContain('<script src="https://assets.example.com/components.js" async defer></script></head>')
        expect(body).toContain('<p>body!</p>')
    })

    it('does not rewrite only to inject the configured script tag when there are no component transforms', async () => {
        const response = html('<html><head><title>t</title></head><body></body></html>')

        const result = await handleSurfaceComponents(
            ctxWith({ injectScriptUrl: 'https://assets.example.com/components.js' }),
            response,
            decisions({}),
            new LolHtmlRewriter(),
        )

        expect(result).toBe(response)
    })

    it('renders multi-item prepend/after lists in array order (reverses each list to compensate for sibling-insertion semantics)', async () => {
        // `reverseTransformPositions` in ContentElementHandler reverses 'after' and 'prepend' so the
        // final document order matches the order authors wrote in the surface-decisions payload.
        // 'before' and 'append' don't need reversal because each call already extends in document order.
        const response = html('<html><body><div class="t">orig</div></body></html>')

        const result = await handleSurfaceComponents(
            baseCtx,
            response,
            decisions({
                t: {
                    metadata: { cssSelector: 'div.t' },
                    content: {
                        before: [
                            { type: 'html', content: '<i>B1</i>' },
                            { type: 'html', content: '<i>B2</i>' },
                        ],
                        prepend: [
                            { type: 'html', content: '<i>P1</i>' },
                            { type: 'html', content: '<i>P2</i>' },
                        ],
                        append: [
                            { type: 'html', content: '<i>A1</i>' },
                            { type: 'html', content: '<i>A2</i>' },
                        ],
                        after: [
                            { type: 'html', content: '<i>F1</i>' },
                            { type: 'html', content: '<i>F2</i>' },
                        ],
                    },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toBe(
            '<html><body><i>B1</i><i>B2</i><div class="t"><i>P1</i><i>P2</i>orig<i>A1</i><i>A2</i></div><i>F1</i><i>F2</i></body></html>',
        )
    })

    it('passes html:false for text content so it is rendered as escaped text rather than parsed as HTML', async () => {
        const response = html('<html><body><span class="t"></span></body></html>')

        const result = await handleSurfaceComponents(
            baseCtx,
            response,
            decisions({
                t: {
                    metadata: { cssSelector: 'span.t' },
                    content: {
                        append: [{ type: 'text', content: '<script>alert(1)</script>' }],
                    },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
        expect(body).not.toContain('<script>alert(1)</script>')
    })

    it('renders web-component element insertions with serialized props', async () => {
        const response = html('<html><body><div class="slot"></div></body></html>')

        const result = await handleSurfaceComponents(
            baseCtx,
            response,
            decisions({
                slot: {
                    metadata: { cssSelector: 'div.slot' },
                    content: {
                        append: [
                            {
                                type: 'element',
                                schema: 'mos:paywall@2',
                                props: { tier: 'premium' },
                            },
                        ],
                    },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toContain('<mos-paywall version="2" props="{&quot;tier&quot;:&quot;premium&quot;}"></mos-paywall>')
    })

    it('skips components whose selector uses :last-child and logs a warning', async () => {
        const { events, logger } = createRecordingLogger()
        const response = html('<html><body><p class="last">a</p><p class="last">b</p></body></html>')

        const result = await handleSurfaceComponents(
            withLogger(logger),
            response,
            decisions({
                bad: {
                    metadata: { cssSelector: 'p.last:last-child' },
                    content: { append: [{ type: 'text', content: 'X' }] },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toBe('<html><body><p class="last">a</p><p class="last">b</p></body></html>')
        expect(events).toContainEqual(expect.objectContaining({ level: 'warn', code: 'component-selector-unsupported' }))
    })

    it('logs and skips a component whose selector the rewriter rejects, leaving other components untouched', async () => {
        const { events, logger } = createRecordingLogger()
        const response = html('<html><body><p class="good">a</p></body></html>')

        const result = await handleSurfaceComponents(
            withLogger(logger),
            response,
            decisions({
                bad: {
                    metadata: { cssSelector: 'p[' },
                    content: { append: [{ type: 'text', content: 'NOPE' }] },
                },
                good: {
                    metadata: { cssSelector: 'p.good' },
                    content: { append: [{ type: 'text', content: '!' }] },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toContain('<p class="good">a!</p>')
        expect(events).toContainEqual(expect.objectContaining({ level: 'error', code: 'component-transform-failed' }))
    })

    it('replaces a range of children between fromMarker and toMarker, keeping the toMarker element intact', async () => {
        const response = html(
            '<html><body><div class="hero"><span class="start">S</span><p>kill1</p><p>kill2</p><span class="end">E</span></div></body></html>',
        )

        const result = await handleSurfaceComponents(
            baseCtx,
            response,
            decisions({
                hero: {
                    metadata: { cssSelector: 'div.hero' },
                    content: {
                        replaceRange: {
                            fromMarker: 'span.start',
                            toMarker: 'span.end',
                            replaceWith: [{ type: 'html', content: '<i>REPLACED</i>' }],
                        },
                    },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        // start marker stays (SCANNING state didn't remove it), replaceWith inserted after it,
        // intermediate <p> elements removed, end marker preserved (REPLACED transition).
        expect(body).toBe(
            '<html><body><div class="hero"><span class="start">S</span><i>REPLACED</i><span class="end">E</span></div></body></html>',
        )
    })

    it('prepends replaceWith into the parent and removes children up to toMarker when fromMarker is omitted', async () => {
        const response = html('<html><body><div class="hero"><p>kill1</p><p>kill2</p><span class="end">E</span></div></body></html>')

        const result = await handleSurfaceComponents(
            baseCtx,
            response,
            decisions({
                hero: {
                    metadata: { cssSelector: 'div.hero' },
                    content: {
                        replaceRange: {
                            toMarker: 'span.end',
                            replaceWith: [{ type: 'html', content: '<b>X</b>' }],
                        },
                    },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toBe('<html><body><div class="hero"><b>X</b><span class="end">E</span></div></body></html>')
    })

    it('renders multiple replaceWith items in array order', async () => {
        // The parent handler reverses replaceWith before prepending so the final document order matches
        // the order in the payload — analogous to reverseTransformPositions for prepend/after.
        const response = html('<html><body><div class="hero"><p>x</p><span class="end">E</span></div></body></html>')

        const result = await handleSurfaceComponents(
            baseCtx,
            response,
            decisions({
                hero: {
                    metadata: { cssSelector: 'div.hero' },
                    content: {
                        replaceRange: {
                            toMarker: 'span.end',
                            replaceWith: [
                                { type: 'html', content: '<i>1</i>' },
                                { type: 'html', content: '<i>2</i>' },
                                { type: 'html', content: '<i>3</i>' },
                            ],
                        },
                    },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toContain('<i>1</i><i>2</i><i>3</i><span class="end">E</span>')
    })

    it('skips replaceRange when fromMarker and toMarker are the same selector', async () => {
        const { events, logger } = createRecordingLogger()
        const response = html('<html><body><div class="hero"><span class="m">m</span><p>p</p></div></body></html>')

        const result = await handleSurfaceComponents(
            withLogger(logger),
            response,
            decisions({
                hero: {
                    metadata: { cssSelector: 'div.hero' },
                    content: {
                        replaceRange: {
                            fromMarker: 'span.m',
                            toMarker: 'span.m',
                            replaceWith: [{ type: 'html', content: '<i>X</i>' }],
                        },
                    },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toBe('<html><body><div class="hero"><span class="m">m</span><p>p</p></div></body></html>')
        expect(events).toContainEqual(expect.objectContaining({ level: 'warn', code: 'replacement-markers-identical' }))
    })

    it('falls back gracefully when findMarkerPositions rejects a marker selector — other components still apply', async () => {
        const { events, logger } = createRecordingLogger()
        const response = html('<html><body><div class="bad">leave</div><div class="ok">orig</div></body></html>')

        const result = await handleSurfaceComponents(
            withLogger(logger),
            response,
            decisions({
                bad: {
                    metadata: { cssSelector: 'div.bad' },
                    content: {
                        // Invalid marker selector — registration in findMarkerPositions throws,
                        // pushes 'bad' into componentsWithInvalidSelectors, and buildReplacementHandlers is skipped.
                        // ContentElementHandler still registers against the (valid) cssSelector — but there
                        // is no content payload here, so the bad component is effectively a no-op.
                        replaceRange: { fromMarker: 'p[', toMarker: 'span.x' },
                    },
                },
                ok: {
                    metadata: { cssSelector: 'div.ok' },
                    content: { append: [{ type: 'text', content: '!' }] },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toContain('<div class="bad">leave</div>')
        expect(body).toContain('<div class="ok">orig!</div>')
        expect(events).toContainEqual(expect.objectContaining({ level: 'error', code: 'marker-pass-selector-failed' }))
    })

    it('does not validate injectScriptUrl — the configured URL is inlined verbatim into the script tag', async () => {
        // Pins current behavior: surfaceComponents trusts the configured URL. If a URL-validation pass is
        // added later, update this test to match the new contract.
        const response = html('<html><head></head><body><p>body</p></body></html>')

        const result = await handleSurfaceComponents(
            ctxWith({ injectScriptUrl: 'javascript:alert(1)' }),
            response,
            decisions({
                p: {
                    metadata: { cssSelector: 'p' },
                    content: { append: [{ type: 'text', content: '!' }] },
                },
            }),
            new LolHtmlRewriter(),
        )

        const body = await result.text()
        expect(body).toContain('<script src="javascript:alert(1)" async defer></script>')
    })

    it('skips components with missing selector or content', async () => {
        const response = html('<html><body><p>only</p></body></html>')

        const result = await handleSurfaceComponents(
            baseCtx,
            response,
            decisions({
                missingSelector: { metadata: { cssSelector: null }, content: { append: [{ type: 'text', content: 'x' }] } },
                missingContent: { metadata: { cssSelector: 'p' } },
            }),
            new LolHtmlRewriter(),
        )

        expect(result).toBe(response)
    })
})
