import { describe, expect, it, vi } from 'vitest'
import type { ElementHandlers, HtmlRewriterSession, RewriterElement } from '../../src/adapters/HtmlRewriterAdapter'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import { registerLinkRewriteHandlers } from '../../src/stages/linkRewriteHandlers'
import rewriteOriginResponse from '../../src/stages/linkRewriting'
import { LolHtmlRewriter } from '../fakes/LolHtmlRewriter'

const silentLogger: MOSProxyLogger = { log() {} }
const makeCtx = (logger: MOSProxyLogger = silentLogger): PipelineContext => ({
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon',
        authenticatedUserJwtCookieName: 'jwt',
    }),
    logger,
})
const proxyRequest = (path = '/article') => new Request(`https://proxy.example.com${path}`)
const rewriter = () => new LolHtmlRewriter()

describe('rewriteOriginResponse', () => {
    it('snapshots attributes before mutating them', async () => {
        let elementHandler: ElementHandlers['element']
        const session: HtmlRewriterSession = {
            on(selector, handlers) {
                if (selector === '*') elementHandler = handlers.element
                return this
            },
            transform(response) {
                return response
            },
        }
        registerLinkRewriteHandlers(session, new URL('https://proxy.example.com/article'), makeCtx().config.originUrl)

        let iterating = false
        const attributes: [string, string][] = [
            ['src', 'https://origin.example.com/image.jpg'],
            ['srcset', 'https://origin.example.com/image-1x.jpg 1x, https://origin.example.com/image-2x.jpg 2x'],
        ]
        const updates: Record<string, string> = {}
        const element: RewriterElement = {
            removed: false,
            tagName: 'img',
            attributes: {
                *[Symbol.iterator]() {
                    iterating = true
                    try {
                        yield* attributes
                    } finally {
                        iterating = false
                    }
                },
            },
            getAttribute: (name) => updates[name] ?? attributes.find(([attrName]) => attrName === name)?.[1] ?? null,
            hasAttribute: (name) => attributes.some(([attrName]) => attrName === name) || updates[name] !== undefined,
            setAttribute: (name, value) => {
                if (iterating) throw new Error('attributes mutated during iteration')
                updates[name] = value
            },
            removeAttribute() {},
            before() {},
            after() {},
            prepend() {},
            append() {},
            replace() {},
            remove() {},
        }

        await elementHandler?.(element)

        expect(updates).toEqual({
            src: 'https://proxy.example.com/image.jpg',
            srcset: 'https://proxy.example.com/image-1x.jpg 1x, https://proxy.example.com/image-2x.jpg 2x',
        })
    })

    it('rewrites origin host references in element attributes', async () => {
        const response = new Response('<a href="https://origin.example.com/x">go</a>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<a href="https://proxy.example.com/x">go</a>')
        expect(result.headers.get('Cache-Control')).toBe('no-store')
    })

    it('rewrites origin host references in response headers', async () => {
        const response = new Response('', {
            status: 302,
            headers: { Location: 'https://origin.example.com/new' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest('/old'), response, rewriter(), { htmlAware: true })

        expect(result.headers.get('Location')).toBe('https://proxy.example.com/new')
    })

    it('rewrites redirect Location when the response has no Content-Type', async () => {
        const response = new Response(null, {
            status: 302,
            headers: { Location: 'https://origin.example.com/new' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest('/old'), response, rewriter())

        expect(result.status).toBe(302)
        expect(result.headers.get('Location')).toBe('https://proxy.example.com/new')
    })

    it('preserves cache headers on passthrough (no body re-stream)', async () => {
        const response = new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter())

        expect(result.headers.get('Cache-Control')).toBe('public, max-age=3600')
    })

    it('returns an empty-body response for redirects without touching the origin stream', async () => {
        const response = new Response('', {
            status: 302,
            headers: { Location: 'https://origin.example.com/new', 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest('/old'), response, rewriter(), { htmlAware: true })

        expect(result.status).toBe(302)
        expect(result.headers.get('Location')).toBe('https://proxy.example.com/new')
        expect(await result.text()).toBe('')
    })

    it.each([204, 205, 304])('returns a null-body response for status %s', async (status) => {
        const response = new Response(null, { status })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(result.status).toBe(status)
        expect(result.body).toBeNull()
    })

    it('strips Content-Length and Content-Encoding when the body will be re-streamed', async () => {
        const response = new Response('<a href="https://origin.example.com/x">go</a>', {
            status: 200,
            headers: {
                'Content-Type': 'text/html',
                'Content-Length': '999',
                'Content-Encoding': 'gzip',
            },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(result.headers.get('Content-Length')).toBeNull()
        expect(result.headers.get('Content-Encoding')).toBeNull()
    })

    it('preserves Content-Length and Content-Encoding on no-body statuses', async () => {
        const response = new Response(null, {
            status: 304,
            headers: { 'Content-Length': '0', 'Content-Encoding': 'gzip' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(result.headers.get('Content-Length')).toBe('0')
        expect(result.headers.get('Content-Encoding')).toBe('gzip')
    })

    it('rewrites URLs inside <script> contents', async () => {
        const response = new Response('<script>var u = "https://origin.example.com/api";</script>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<script>var u = "https://proxy.example.com/api";</script>')
    })

    it('rewrites url(...) inside <style> contents', async () => {
        const response = new Response('<style>body { background: url(https://origin.example.com/x.png); }</style>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<style>body { background: url(https://proxy.example.com/x.png); }</style>')
    })

    it('rewrites url(...) inside an inline style attribute', async () => {
        const response = new Response('<div style="background: url(https://origin.example.com/x.png)"></div>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<div style="background: url(https://proxy.example.com/x.png)"></div>')
    })

    it('rewrites every URL in a srcset attribute', async () => {
        const response = new Response('<img srcset="https://origin.example.com/a.png 1x, https://origin.example.com/b.png 2x">', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<img srcset="https://proxy.example.com/a.png 1x, https://proxy.example.com/b.png 2x">')
    })

    it('rewrites SVG href and xlink:href', async () => {
        const response = new Response(
            '<svg><image href="https://origin.example.com/a.png"/><use xlink:href="https://origin.example.com/icons.svg#x"/></svg>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
        )

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(
            '<svg><image href="https://proxy.example.com/a.png" /><use xlink:href="https://proxy.example.com/icons.svg#x" /></svg>',
        )
    })

    it('rewrites iframe srcdoc content', async () => {
        const response = new Response('<iframe srcdoc="<a href=&quot;https://origin.example.com/x&quot;>x</a>"></iframe>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<iframe srcdoc="<a href=&quot;https://proxy.example.com/x&quot;>x</a>"></iframe>')
    })

    it('rewrites legacy background attribute on body/table', async () => {
        const response = new Response(
            '<body background="https://origin.example.com/bg.png"><table background="https://origin.example.com/t.png"></table></body>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
        )

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(
            '<body background="https://proxy.example.com/bg.png"><table background="https://proxy.example.com/t.png"></table></body>',
        )
    })

    it('rewrites <link imagesrcset> for responsive preloads', async () => {
        const response = new Response(
            '<link rel="preload" as="image" imagesrcset="https://origin.example.com/a.png 1x, https://origin.example.com/b.png 2x">',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
        )

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(
            '<link rel="preload" as="image" imagesrcset="https://proxy.example.com/a.png 1x, https://proxy.example.com/b.png 2x">',
        )
    })

    it('rewrites microdata itemid and RDFa resource attributes', async () => {
        const response = new Response(
            '<div itemid="https://origin.example.com/thing"><span resource="https://origin.example.com/other"></span></div>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
        )

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(
            '<div itemid="https://proxy.example.com/thing"><span resource="https://proxy.example.com/other"></span></div>',
        )
    })

    it('rewrites common data-* URL attributes (accepts false positives)', async () => {
        const response = new Response(
            '<img data-src="https://origin.example.com/lazy.png" data-srcset="https://origin.example.com/a.png 1x"><div data-href="https://origin.example.com/x"></div>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
        )

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(
            '<img data-src="https://proxy.example.com/lazy.png" data-srcset="https://proxy.example.com/a.png 1x"><div data-href="https://proxy.example.com/x"></div>',
        )
    })

    it('rewrites URLs inside <template> contents', async () => {
        const response = new Response('<template><a href="https://origin.example.com/x">x</a></template>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<template><a href="https://proxy.example.com/x">x</a></template>')
    })

    it('does not rewrite origin URLs that appear in prose text', async () => {
        const html = '<p>Visit https://origin.example.com/foo for more.</p>'
        const response = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(html)
    })

    it('rewrites URLs that straddle a chunk boundary inside <script>', async () => {
        // Split the URL right after the scheme so a naive per-chunk replace would miss it.
        const before = '<script>var u = "https://orig'
        const after = 'in.example.com/api";</script>'
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder()
                controller.enqueue(enc.encode(before))
                controller.enqueue(enc.encode(after))
                controller.close()
            },
        })
        const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('<script>var u = "https://proxy.example.com/api";</script>')
    })

    it('extracts page metadata from <meta> tags during the same pass', async () => {
        const html =
            '<html><head>' +
            '<meta name="description" content="hello">' +
            '<meta property="og:url" content="https://origin.example.com/page">' +
            '<meta property="og:image" content="https://origin.example.com/img.png">' +
            '</head><body><a href="https://origin.example.com/x">x</a></body></html>'
        const response = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { response: result, pageMetadata } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), {
            htmlAware: true,
        })
        // The body must be drained for the rewriter to run and metadata to populate.
        await result.text()

        expect(pageMetadata).toEqual({
            description: 'hello',
            'og:url': 'https://proxy.example.com/page',
            'og:image': 'https://proxy.example.com/img.png',
        })
    })

    it('rewrites origin URLs in a JSON body via streaming regex', async () => {
        const body = JSON.stringify({ url: 'https://origin.example.com/api', other: 'https://cdn.example.org/x' })
        const response = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(JSON.stringify({ url: 'https://proxy.example.com/api', other: 'https://cdn.example.org/x' }))
    })

    it('rewrites origin URLs in a markdown/plain text body via streaming regex', async () => {
        const body = 'See [docs](https://origin.example.com/docs) for details.'
        const response = new Response(body, { status: 200, headers: { 'Content-Type': 'text/markdown' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('See [docs](https://proxy.example.com/docs) for details.')
    })

    it('rewrites origin URLs in an application/ld+json body', async () => {
        const body = '{"@context":"https://schema.org","url":"https://origin.example.com/page"}'
        const response = new Response(body, { status: 200, headers: { 'Content-Type': 'application/ld+json' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('{"@context":"https://schema.org","url":"https://proxy.example.com/page"}')
    })

    it('passes binary content through unchanged (no body mutation)', async () => {
        const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG header bytes
        const response = new Response(body, { status: 200, headers: { 'Content-Type': 'image/png' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        const buf = new Uint8Array(await result.arrayBuffer())
        expect(buf).toEqual(body)
    })

    it('passthrough rewrites URL headers but preserves cache headers and does not force no-store', async () => {
        const original = new Response('binary', {
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=3600',
                Location: 'https://origin.example.com/redirect',
            },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), original, rewriter(), { htmlAware: true })

        expect(result.headers.get('Cache-Control')).toBe('public, max-age=3600')
        expect(result.headers.get('Location')).toBe('https://proxy.example.com/redirect')
    })

    it.each([
        'text/css',
        'application/javascript',
        'text/javascript',
        'application/ecmascript',
    ])('leaves %s subresource bodies byte-identical (SRI integrity preserved)', async (contentType) => {
        const body = '/* contains https://origin.example.com/asset */ console.log(1)'
        const original = new Response(body, {
            status: 200,
            headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), original, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(body)
        expect(result.headers.get('Cache-Control')).toBe('public, max-age=3600')
    })

    it('passes through bodies with no Content-Type header (conservative)', async () => {
        const body = 'https://origin.example.com/x'
        const noCtResponse = new Response(body, { status: 200, headers: { 'Content-Type': '' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), noCtResponse, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe(body)
    })

    it('rewrites streaming regex URLs across chunk boundaries in JSON', async () => {
        const before = '{"u":"https://orig'
        const after = 'in.example.com/api"}'
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder()
                controller.enqueue(enc.encode(before))
                controller.enqueue(enc.encode(after))
                controller.close()
            },
        })
        const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, rewriter(), { htmlAware: true })

        expect(await result.text()).toBe('{"u":"https://proxy.example.com/api"}')
    })

    it('returns empty pageMetadata when no htmlRewriter is configured', async () => {
        const log = vi.fn()
        const ctx = makeCtx({ log })
        const response = new Response('<meta name="x" content="y">', { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { pageMetadata } = rewriteOriginResponse(ctx, proxyRequest(), response, null)

        expect(pageMetadata).toEqual({})
    })

    it('htmlAware mode silently falls back to streaming-regex when no htmlRewriter is configured', async () => {
        const ctx = makeCtx()
        const body = '<a href="https://origin.example.com/x">go</a>'
        const response = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { response: result } = rewriteOriginResponse(ctx, proxyRequest(), response, null, { htmlAware: true })

        // Same byte-substitution streaming-regex would have produced.
        expect(await result.text()).toBe('<a href="https://proxy.example.com/x">go</a>')
    })
})

describe('rewriteOriginResponse (default regex mode)', () => {
    // Default mode (htmlAware not opted in): HTML payloads are rewritten via streaming regex
    // exactly like JSON/markdown. Option-1 scope: every byte-sequence match is replaced.

    it('rewrites URLs in HTML attributes', async () => {
        const response = new Response('<a href="https://origin.example.com/x">go</a>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, null)

        expect(await result.text()).toBe('<a href="https://proxy.example.com/x">go</a>')
    })

    it('rewrites URLs in prose text (option-1 scope, unlike htmlAware mode)', async () => {
        const html = '<p>Visit https://origin.example.com/foo for more.</p>'
        const response = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, null)

        expect(await result.text()).toBe('<p>Visit https://proxy.example.com/foo for more.</p>')
    })

    it('does not require an htmlRewriter', async () => {
        const response = new Response('<a href="https://origin.example.com/x">go</a>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const { response: result, pageMetadata } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, null)

        expect(await result.text()).toBe('<a href="https://proxy.example.com/x">go</a>')
        expect(pageMetadata).toEqual({})
    })

    it('preserves byte-identical output for non-matching segments', async () => {
        // lol-html reserializes (adds whitespace, normalizes quotes); streaming-regex preserves
        // the original bytes outside of replaced URLs.
        const html = '<image href="https://origin.example.com/a.png"/>'
        const response = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { response: result } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, null)

        // No space added before `/>` — bytes are preserved (the htmlAware path would emit a space).
        expect(await result.text()).toBe('<image href="https://proxy.example.com/a.png"/>')
    })

    it('does not extract pageMetadata (always empty)', async () => {
        const html = '<meta property="og:url" content="https://origin.example.com/page">'
        const response = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })

        const { pageMetadata } = rewriteOriginResponse(makeCtx(), proxyRequest(), response, null)

        expect(pageMetadata).toEqual({})
    })
})
