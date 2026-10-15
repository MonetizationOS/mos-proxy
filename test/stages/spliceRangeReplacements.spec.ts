import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import { spliceRangeReplacements } from '../../src/stages/spliceRangeReplacements'
import handleSurfaceComponents, { transformComponents } from '../../src/stages/surfaceComponents'
import type { SubSurfaceBehaviorApi, SurfaceDecisionResponse } from '../../src/types'
import { LolHtmlRewriter } from '../fakes/LolHtmlRewriter'

type Behaviors = Record<string, SubSurfaceBehaviorApi>

const ctx: PipelineContext = {
    logger: { log() {} },
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon-session',
        authenticatedUserJwtCookieName: '__session',
    }),
}
const html = (body: string) =>
    new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length) } })
const decision = (componentBehaviors: Behaviors): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier: 'anon', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped: false,
    componentBehaviors,
})

const range = (cssSelector: string, replaceRange: object, rest: object = {}) =>
    ({
        metadata: { cssSelector },
        content: { replaceRange: { replaceWith: [{ type: 'html', content: '<i>R</i>' }], ...replaceRange }, ...rest },
    }) as SubSurfaceBehaviorApi

const article = (body: string) => `<html><body><h1>T</h1><p class="byline">By</p>${body}</body></html>`

const cases: { name: string; html: string; behaviors: Behaviors; spliced: boolean }[] = [
    {
        name: 'from and to markers as direct children (core fixture)',
        html: '<html><body><div class="hero"><span class="start">S</span><p>kill1</p><p>kill2</p><span class="end">E</span></div></body></html>',
        behaviors: { hero: range('div.hero', { fromMarker: 'span.start', toMarker: 'span.end' }) },
        spliced: true,
    },
    {
        name: 'no fromMarker: cut from the container start (core fixture)',
        html: '<html><body><div class="hero"><p>kill1</p><p>kill2</p><span class="end">E</span></div></body></html>',
        behaviors: { hero: range('div.hero', { toMarker: 'span.end' }) },
        spliced: true,
    },
    {
        name: 'several replaceWith items keep their order (core fixture)',
        html: '<html><body><div class="hero"><p>x</p><span class="end">E</span></div></body></html>',
        behaviors: {
            hero: range('div.hero', {
                toMarker: 'span.end',
                replaceWith: ['1', '2', '3'].map((n) => ({ type: 'html', content: `<i>${n}</i>` })),
            }),
        },
        spliced: true,
    },
    {
        name: 'identical markers are left to the core, which skips them (core fixture)',
        html: '<html><body><div class="hero"><span class="m">m</span><p>p</p></div></body></html>',
        behaviors: { hero: range('div.hero', { fromMarker: 'span.m', toMarker: 'span.m' }) },
        spliced: false,
    },
    {
        name: 'paywall after the lede, to the end of the article',
        html: article('<article class="post"><p class="lede">L</p><p>a</p>\n<p>b <b>x</b></p> tail</article><footer>F</footer>'),
        behaviors: { paywall: range('article.post', { fromMarker: 'p.lede' }) },
        spliced: true,
    },
    {
        name: 'text and web-component replacements are rendered by the core',
        html: article('<article class="post"><p class="lede">L</p><p>a</p></article>'),
        behaviors: {
            paywall: range('article.post', {
                fromMarker: 'p.lede',
                replaceWith: [
                    { type: 'text', content: 'Read <more>' },
                    { type: 'element', schema: 'mos:paywall@2', props: { tier: 'gold' } },
                ],
            }),
        },
        spliced: true,
    },
    {
        name: 'no replaceWith: the range is only removed',
        html: article('<article class="post"><p class="lede">L</p><p>a</p></article>'),
        behaviors: { paywall: range('article.post', { fromMarker: 'p.lede', replaceWith: [] }) },
        spliced: true,
    },
    {
        name: 'fromMarker absent: nothing changes',
        html: article('<article class="post"><p>a</p><p>b</p></article>'),
        behaviors: { paywall: range('article.post', { fromMarker: 'p.lede' }) },
        spliced: true,
    },
    {
        name: 'fromMarker nested below a direct child falls back',
        html: article('<article class="post"><div><p class="lede">L</p><p>a</p></div><p>b</p></article>'),
        behaviors: { paywall: range('article.post', { fromMarker: 'p.lede' }) },
        spliced: false,
    },
    {
        name: 'toMarker nested below a direct child falls back',
        html: article('<article class="post"><p class="lede">L</p><p>a</p><div><span class="end">E</span></div><p>b</p></article>'),
        behaviors: { paywall: range('article.post', { fromMarker: 'p.lede', toMarker: 'span.end' }) },
        spliced: false,
    },
    {
        name: 'a toMarker inside the start marker is ignored, as while the core is scanning',
        html: '<html><body><div class="hero"><span class="start"><span class="end">in</span></span><p>k</p><span class="end">E</span></div></body></html>',
        behaviors: { hero: range('div.hero', { fromMarker: 'span.start', toMarker: 'span.end' }) },
        spliced: true,
    },
    {
        name: 'an element matching both markers starts the range, the next match ends it',
        html: '<html><body><div class="hero"><p class="a">A</p><p>k</p><p>E</p></div></body></html>',
        behaviors: { hero: range('div.hero', { fromMarker: 'p.a', toMarker: 'p' }) },
        spliced: true,
    },
    {
        name: 'several matching containers are each cut',
        html: '<html><body><div class="hero"><b class="s">1</b><p>x</p></div><div class="hero"><b class="s">2</b><p>y</p></div></body></html>',
        behaviors: { hero: range('div.hero', { fromMarker: 'b.s' }) },
        spliced: true,
    },
    {
        name: 'nested matching containers fall back',
        html: '<html><body><div class="hero"><b class="s">1</b><div class="hero"><b class="s">2</b><p>y</p></div></div></body></html>',
        behaviors: { hero: range('div.hero', { fromMarker: 'b.s' }) },
        spliced: false,
    },
    {
        name: 'two ranges in different containers',
        html: '<html><body><div class="a"><b>1</b><p>x</p></div><div class="b"><b>2</b><p>y</p></div></body></html>',
        behaviors: { a: range('div.a', { fromMarker: 'b' }), b: range('div.b', { fromMarker: 'b' }) },
        spliced: true,
    },
    {
        name: 'two ranges in the same container overlap and fall back',
        html: '<html><body><div class="a"><b>1</b><i>2</i><p>x</p></div></body></html>',
        behaviors: { a: range('div.a', { fromMarker: 'b' }), b: range('div.a', { fromMarker: 'i' }) },
        spliced: false,
    },
    {
        name: 'other components and the range component’s own content still apply',
        html: article('<article class="post"><p class="lede">L</p><p>a</p></article>'),
        behaviors: {
            paywall: range('article.post', { fromMarker: 'p.lede' }, { before: [{ type: 'html', content: '<hr>' }] }),
            badge: { metadata: { cssSelector: 'p.byline' }, content: { append: [{ type: 'html', content: ' · Members' }] } },
        },
        spliced: true,
    },
    {
        name: 'an invalid marker selector falls back, and the core still applies the other components',
        html: article('<article class="post"><p class="lede">L</p><p>a</p></article>'),
        behaviors: {
            paywall: range('article.post', { fromMarker: 'p[' }),
            badge: { metadata: { cssSelector: 'p.byline' }, content: { append: [{ type: 'html', content: ' · Members' }] } },
        },
        spliced: false,
    },
    {
        name: 'a 200 KB article',
        html: article(`<article class="post"><p class="lede">L</p>${'<p>Gauge readings, hour by hour.</p>\n'.repeat(6000)}</article>`),
        behaviors: { paywall: range('article.post', { fromMarker: 'p.lede' }) },
        spliced: true,
    },
]

// The splice must give exactly what the per-element path gives, and say when it stood aside.
describe('spliceRangeReplacements', () => {
    it.each(cases)('$name', async ({ html: page, behaviors, spliced }) => {
        const d = decision(behaviors)
        const expected = await (await transformComponents(ctx, html(page), d, new LolHtmlRewriter())).text()

        expect((await spliceRangeReplacements(html(page), d, new LolHtmlRewriter())) !== null).toBe(spliced)
        const result = await handleSurfaceComponents(ctx, html(page), d, new LolHtmlRewriter())
        const actual = await result.text()
        expect(actual).toBe(expected)
        expect(actual).not.toContain('mos-range')
        if (spliced) expect(result.headers.get('content-length')).toBeNull()
    })
})
