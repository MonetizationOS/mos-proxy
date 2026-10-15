import { describe, expect, it } from 'vitest'
import { applyComponentBehaviors, type MOSProxyLogger, parsePageMetadata, type SurfaceDecisionResponse } from '../src/index'
import { LolHtmlRewriter } from './fakes/LolHtmlRewriter'

const logger: MOSProxyLogger = { log() {} }
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
const decision = (componentBehaviors: SurfaceDecisionResponse['componentBehaviors']): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier: 'anon', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped: false,
    componentBehaviors,
})

describe('applyComponentBehaviors', () => {
    it('applies component behaviors to a page outside the proxy pipeline', async () => {
        const result = await applyComponentBehaviors(
            html('<html><head></head><body><article><p class="lede">L</p><p>more</p></article></body></html>'),
            decision({
                paywall: {
                    metadata: { cssSelector: 'article' },
                    content: {
                        append: [{ type: 'html', content: '<aside>Subscribe</aside>' }],
                        replaceRange: { fromMarker: 'p.lede', replaceWith: [{ type: 'html', content: '<b>…</b>' }] },
                    },
                },
            }),
            new LolHtmlRewriter(),
            { logger },
        )

        expect(await result.text()).toBe(
            '<html><head></head><body><article><p class="lede">L</p><b>…</b><aside>Subscribe</aside></article></body></html>',
        )
    })

    it('injects the script tag only when asked', async () => {
        const page = '<html><head></head><body><p>x</p></body></html>'
        const behaviors = { c: { metadata: { cssSelector: 'p' }, content: { append: [{ type: 'text' as const, content: '!' }] } } }

        const withScript = await applyComponentBehaviors(html(page), decision(behaviors), new LolHtmlRewriter(), {
            logger,
            injectScriptUrl: 'https://cdn.example.com/mos.js',
        })
        const without = await applyComponentBehaviors(html(page), decision(behaviors), new LolHtmlRewriter(), { logger })

        expect(await withScript.text()).toContain('<script src="https://cdn.example.com/mos.js" async defer></script></head>')
        expect(await without.text()).not.toContain('<script')
    })
})

describe('parsePageMetadata', () => {
    it('reads name and property meta tags', async () => {
        const meta = await parsePageMetadata(
            html(
                '<html><head><meta name="category" content="science"><meta property="og:title" content="Tides"><meta charset="utf-8"></head></html>',
            ),
            new LolHtmlRewriter(),
            { logger },
        )

        expect(meta).toEqual({ category: 'science', 'og:title': 'Tides' })
    })
})
