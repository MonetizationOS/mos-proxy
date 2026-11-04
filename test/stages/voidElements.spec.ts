import { describe, expect, it } from 'vitest'
import type { ElementHandlers, HtmlRewriterAdapter, HtmlRewriterSession, RewriterElement } from '../../src/adapters/HtmlRewriterAdapter'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import handleSurfaceComponents from '../../src/stages/surfaceComponents'
import { isVoidElement } from '../../src/stages/voidElements'
import type { SurfaceDecisionResponse } from '../../src/types'
import { LolHtmlRewriter } from '../fakes/LolHtmlRewriter'

const ctx: PipelineContext = {
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon-session',
        authenticatedUserJwtCookieName: '__session',
    }),
    logger: { log() {} },
}

/** Wraps the real rewriter and records the tag of every element `onEndTag` is called on. */
class EndTagSpyRewriter implements HtmlRewriterAdapter {
    readonly inner = new LolHtmlRewriter()
    readonly capabilities = this.inner.capabilities
    readonly endTagCalls: string[] = []

    create(): HtmlRewriterSession {
        const session = this.inner.create()
        const spy: HtmlRewriterSession = {
            on: (selector: string, handlers: ElementHandlers) => {
                session.on(selector, {
                    ...handlers,
                    element: handlers.element
                        ? (element) =>
                              handlers.element?.({
                                  get removed() {
                                      return element.removed
                                  },
                                  get tagName() {
                                      return element.tagName
                                  },
                                  get namespaceURI() {
                                      return element.namespaceURI
                                  },
                                  getAttribute: (name) => element.getAttribute(name),
                                  hasAttribute: (name) => element.hasAttribute(name),
                                  setAttribute: (name, value) => element.setAttribute(name, value),
                                  removeAttribute: (name) => element.removeAttribute(name),
                                  before: (content, options) => element.before(content, options),
                                  after: (content, options) => element.after(content, options),
                                  prepend: (content, options) => element.prepend(content, options),
                                  append: (content, options) => element.append(content, options),
                                  replace: (content, options) => element.replace(content, options),
                                  remove: () => element.remove(),
                                  onEndTag: (callback) => {
                                      this.endTagCalls.push(element.tagName.toLowerCase())
                                      element.onEndTag?.(callback)
                                  },
                              })
                        : undefined,
                })
                return spy
            },
            transform: (response) => session.transform(response),
        }
        return spy
    }
}

const decisions = (replaceRange: { fromMarker?: string; toMarker?: string }, cssSelector = 'div.hero'): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier: 'anon', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped: false,
    componentBehaviors: {
        hero: {
            metadata: { cssSelector },
            content: { replaceRange: { ...replaceRange, replaceWith: [{ type: 'html', content: '<i>NEW</i>' }] } },
        },
    },
})

const run = async (body: string, replaceRange: { fromMarker?: string; toMarker?: string }, cssSelector?: string) => {
    const rewriter = new EndTagSpyRewriter()
    const response = new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    const result = await handleSurfaceComponents(ctx, response, decisions(replaceRange, cssSelector), rewriter)
    return { body: await result.text(), endTagCalls: rewriter.endTagCalls }
}

describe('range replacement with void elements', () => {
    const VOID_TAGS = ['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr']

    it('does not call onEndTag on void elements and replaces the range as before', async () => {
        const { body, endTagCalls } = await run(
            '<div class="hero"><span class="start">S</span><img src="a.png"><br><p>kill<hr><input></p><wbr><span class="end">E</span></div>',
            { fromMarker: 'span.start', toMarker: 'span.end' },
        )
        expect(body).toBe('<div class="hero"><span class="start">S</span><i>NEW</i><span class="end">E</span></div>')
        for (const tag of VOID_TAGS) {
            expect(endTagCalls).not.toContain(tag)
        }
        expect(endTagCalls).toContain('p')
    })

    it('still calls onEndTag on a void-named element inside SVG, which has an end tag', async () => {
        const { body, endTagCalls } = await run(
            '<div class="hero"><svg><source class="start"><circle/></source><link><desc>x</desc></link></svg><span class="end">E</span></div>',
            { fromMarker: 'source.start', toMarker: 'span.end' },
        )
        expect(body).toBe('<div class="hero"><svg><source class="start"><circle/></source><i>NEW</i></svg><span class="end">E</span></div>')
        expect(endTagCalls).toContain('source')
    })

    it('handles a void element as the fromMarker without calling onEndTag on it', async () => {
        const { body, endTagCalls } = await run(
            '<div class="hero"><p>keep</p><hr class="start"><p>kill</p><span class="end">E</span></div>',
            { fromMarker: 'hr.start', toMarker: 'span.end' },
        )
        expect(body).toBe('<div class="hero"><p>keep</p><hr class="start"><i>NEW</i><span class="end">E</span></div>')
        expect(endTagCalls).not.toContain('hr')
    })
})

describe('isVoidElement', () => {
    const element = (tagName: string, namespaceURI?: string) => ({ tagName, namespaceURI }) as RewriterElement
    const HTML = 'http://www.w3.org/1999/xhtml'
    const SVG = 'http://www.w3.org/2000/svg'

    it.each([
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
    ])('treats an HTML <%s> as void', (tag) => {
        expect(isVoidElement(element(tag, HTML))).toBe(true)
    })

    it('does not treat elements with an end tag as void', () => {
        expect(isVoidElement(element('p', HTML))).toBe(false)
        expect(isVoidElement(element('link', SVG))).toBe(false)
    })

    it('does not treat an element with no namespace as void', () => {
        expect(isVoidElement(element('br'))).toBe(false)
    })
})

describe('range replacement when the container has no end tag', () => {
    it.each([
        ['without markers', {}],
        ['with a fromMarker', { fromMarker: 'span' }],
    ])('leaves a void container alone %s', async (_, replaceRange) => {
        const html = '<p>a</p><img class="hero" src="x.png"><p>b</p>'
        const { body } = await run(html, replaceRange, 'img.hero')
        expect(body).toBe(html)
    })

    it('leaves a self-closing foreign container alone', async () => {
        const html = '<svg><path class="hero" d="M0"/></svg><p>b</p>'
        const { body } = await run(html, {}, 'path.hero')
        expect(body).toBe(html)
    })

    it('pops the state of a void container nested in a matching container', async () => {
        const { body } = await run(
            '<div class="hero"><span class="s">s</span><img class="hero"><p>x</p></div>',
            { fromMarker: '.s' },
            '.hero',
        )
        expect(body).toBe('<div class="hero"><span class="s">s</span><i>NEW</i></div>')
    })

    it('still replaces the content of a void-named container inside SVG', async () => {
        const { body } = await run('<svg><link class="hero"><circle/></link></svg>', {}, 'link.hero')
        expect(body).toBe('<svg><link class="hero"><i>NEW</i></link></svg>')
    })

    it('still replaces a later container once an earlier match had no end tag', async () => {
        const { body } = await run('<img class="hero"><svg><path class="hero"/></svg><div class="hero"><p>x</p></div>', {}, '.hero')
        expect(body).toBe('<img class="hero"><svg><path class="hero"/></svg><div class="hero"><i>NEW</i></div>')
    })
})
