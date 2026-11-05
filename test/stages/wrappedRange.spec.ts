import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import handleSurfaceComponents, { applyComponents } from '../../src/stages/surfaceComponents'
import type { SurfaceDecisionResponse, WebElement } from '../../src/types'
import { EndTagSpyRewriter } from '../fakes/EndTagSpyRewriter'

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

type Range = { fromMarker?: string; toMarker?: string; replaceWith?: WebElement[] }
type Others = Record<string, { selector: string; content: Record<string, unknown> }>
type Options = { others?: Others; othersFirst?: boolean }
const html = (content: string) => ({ type: 'html' as const, content })

const decision = (selector: string, range: Range, { others = {}, othersFirst = false }: Options = {}): SurfaceDecisionResponse => {
    const rangeBehavior = {
        range: { metadata: { cssSelector: selector }, content: { replaceRange: { replaceWith: [html('<i>NEW</i>')], ...range } } },
    }
    const otherBehaviors = Object.fromEntries(
        Object.entries(others).map(([key, { selector: cssSelector, content }]) => [key, { metadata: { cssSelector }, content }]),
    )
    return {
        status: 'success',
        identity: { identifier: 'anon', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
        features: {},
        customer: { hasProducts: false },
        surfaceBehavior: {},
        componentsSkipped: false,
        componentBehaviors: othersFirst ? { ...otherBehaviors, ...rangeBehavior } : { ...rangeBehavior, ...otherBehaviors },
    }
}

const run = async (body: string, selector: string, range: Range, options?: Options, elementByElement = false) => {
    const rewriter = new EndTagSpyRewriter()
    const response = new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    const decisions = decision(selector, range, options)
    const result = elementByElement
        ? await applyComponents(ctx, response, decisions, rewriter, null)
        : await handleSurfaceComponents(ctx, response, decisions, rewriter)
    return { body: await result.text(), endTagCalls: rewriter.endTagCalls }
}

/** Runs the page through the wrapper and element by element, and expects the same output from both. */
const bothWays = async (body: string, selector: string, range: Range, options?: Options) => {
    const wrapped = await run(body, selector, range, options)
    const elementByElement = await run(body, selector, range, options, true)
    expect(wrapped.body).toBe(elementByElement.body)
    return { ...wrapped, elementByElement }
}

const page = '<div class="c"><h1>t</h1><p class="s">a</p><p>b</p><section><p>c</p></section><hr class="e"><p>d</p></div><footer>f</footer>'

describe('range replacement by wrapper', () => {
    it('cuts from the start marker to the end of the container with one callback', async () => {
        const { body, endTagCalls, elementByElement } = await bothWays(page, '.c', { fromMarker: 'p.s' })
        expect(body).toBe('<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i></div><footer>f</footer>')
        expect(endTagCalls.sort()).toEqual(['div', 'p'])
        expect(elementByElement.endTagCalls.length).toBeGreaterThan(endTagCalls.length)
    })

    it('keeps the end marker and what follows it', async () => {
        const { body } = await bothWays(page, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' })
        expect(body).toBe('<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i><hr class="e"><p>d</p></div><footer>f</footer>')
    })

    it('cuts from the top of the container when there is only an end marker', async () => {
        const { body } = await bothWays(page, '.c', { toMarker: 'hr.e' })
        expect(body).toBe('<div class="c"><i>NEW</i><hr class="e"><p>d</p></div><footer>f</footer>')
    })

    it('replaces the whole container content when there are no markers', async () => {
        const { body } = await bothWays(page, '.c', {})
        expect(body).toBe('<div class="c"><i>NEW</i></div><footer>f</footer>')
    })

    it('removes the range when there is nothing to replace it with', async () => {
        const { body } = await bothWays(page, '.c', { fromMarker: 'p.s', replaceWith: [] })
        expect(body).toBe('<div class="c"><h1>t</h1><p class="s">a</p></div><footer>f</footer>')
    })

    it('cuts each matching container', async () => {
        const two = '<div class="c"><p class="s">a</p><p>b</p></div><div class="c"><p class="s">c</p><p>d</p></div>'
        const { body } = await bothWays(two, '.c', { fromMarker: 'p.s' })
        expect(body).toBe('<div class="c"><p class="s">a</p><i>NEW</i></div><div class="c"><p class="s">c</p><i>NEW</i></div>')
    })

    it('leaves the container alone when the start marker is absent', async () => {
        const { body } = await bothWays('<div class="c"><p>a</p><p>b</p></div>', '.c', { fromMarker: 'p.s' })
        expect(body).toBe('<div class="c"><p>a</p><p>b</p></div>')
    })

    it('ignores an end marker before the start marker', async () => {
        const { body } = await bothWays('<div class="c"><hr class="e"><p class="s">a</p><p>b</p></div>', '.c', {
            fromMarker: 'p.s',
            toMarker: 'hr.e',
        })
        expect(body).toBe('<div class="c"><hr class="e"><p class="s">a</p><i>NEW</i></div>')
    })

    it('starts the range on an element that matches both markers', async () => {
        const { body } = await bothWays('<div class="c"><p class="s e">a</p><p>b</p></div>', '.c', { fromMarker: '.s', toMarker: '.e' })
        expect(body).toBe('<div class="c"><p class="s e">a</p><i>NEW</i></div>')
    })

    it('starts the range on a void element that matches both markers', async () => {
        const { body } = await bothWays('<div class="c"><hr class="s e"><p>b</p></div>', '.c', { fromMarker: '.s', toMarker: '.e' })
        expect(body).toBe('<div class="c"><hr class="s e"><i>NEW</i></div>')
    })

    it('removes comments inside the cut', async () => {
        const { body } = await run('<div class="c"><p class="s">a</p><!-- gone --><p>b</p></div>', '.c', { fromMarker: 'p.s' })
        expect(body).toBe('<div class="c"><p class="s">a</p><i>NEW</i></div>')
    })

    it('cuts after a start marker that holds another with one callback', async () => {
        const { body, endTagCalls } = await bothWays('<div class="c"><div class="s"><p class="s">a</p><p>b</p></div><p>c</p></div>', '.c', {
            fromMarker: '.s',
        })
        expect(body).toBe('<div class="c"><div class="s"><p class="s">a</p><p>b</p></div><i>NEW</i></div>')
        expect(endTagCalls.sort()).toEqual(['div', 'div'])
    })

    it('leaves a container with no end tag alone', async () => {
        const { body, endTagCalls } = await bothWays('<p>a</p><img class="c" src="x.png"><p>b</p>', 'img.c', {})
        expect(body).toBe('<p>a</p><img class="c" src="x.png"><p>b</p>')
        expect(endTagCalls).toEqual([])
    })

    it('leaves a response with no body alone', async () => {
        const rewriter = new EndTagSpyRewriter()
        const response = new Response(null, { status: 304, headers: { 'Content-Type': 'text/html' } })
        const result = await handleSurfaceComponents(ctx, response, decision('.c', { fromMarker: 'p.s' }), rewriter)
        expect(result.status).toBe(304)
    })

    describe('other components', () => {
        const around: Others = {
            container: { selector: '.c', content: { prepend: [html('<b>P</b>')], append: [html('<b>A</b>')] } },
            start: { selector: 'p.s', content: { before: [html('<u>B</u>')], after: [html('<u>F</u>')] } },
            end: { selector: 'hr.e', content: { before: [html('<s>B</s>')], after: [html('<s>F</s>')] } },
        }

        it('keep what they insert around the container and the markers', async () => {
            const { body } = await bothWays(page, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' }, { others: around })
            expect(body).toBe(
                '<div class="c"><b>P</b><h1>t</h1><u>B</u><p class="s">a</p><u>F</u><i>NEW</i><s>B</s><hr class="e"><s>F</s><p>d</p><b>A</b></div><footer>f</footer>',
            )
        })

        it('keep what they append to a container cut to its end', async () => {
            const { body } = await bothWays(page, '.c', { fromMarker: 'p.s' }, { others: { container: around.container as never } })
            expect(body).toBe('<div class="c"><b>P</b><h1>t</h1><p class="s">a</p><i>NEW</i><b>A</b></div><footer>f</footer>')
        })

        it('still apply to the content that stays', async () => {
            const others = { heading: { selector: 'h1', content: { append: [html('<em>x</em>')] } } }
            const { body } = await bothWays(page, '.c', { fromMarker: 'p.s' }, { others })
            expect(body).toBe('<div class="c"><h1>t<em>x</em></h1><p class="s">a</p><i>NEW</i></div><footer>f</footer>')
        })
    })

    describe('falls back to cutting element by element', () => {
        const expectsFallback = async (body: string, selector: string, range: Range, options?: Options) => {
            const { endTagCalls, elementByElement } = await bothWays(body, selector, range, options)
            // The abandoned wrapper pass may have registered callbacks before the element path starts over
            expect(endTagCalls.slice(-elementByElement.endTagCalls.length)).toEqual(elementByElement.endTagCalls)
        }

        it('when the start marker is not a direct child of the container', async () => {
            await expectsFallback('<div class="c"><section><p class="s">a</p><p>b</p></section><p>c</p></div>', '.c', { fromMarker: 'p.s' })
        })

        it('when the end marker is not a direct child of the container', async () => {
            await expectsFallback('<div class="c"><p class="s">a</p><p>b</p><section><hr class="e"><p>c</p></section></div>', '.c', {
                fromMarker: 'p.s',
                toMarker: 'hr.e',
            })
        })

        it('when containers are nested', async () => {
            await expectsFallback('<div class="c"><p>a</p><div class="c"><p class="s">b</p><p>c</p></div></div>', '.c', {
                fromMarker: 'p.s',
            })
        })

        it('when a component before the range removes a marker', async () => {
            for (const marker of ['p.s', 'hr.e']) {
                const options = { others: { gone: { selector: marker, content: { remove: true } } }, othersFirst: true }
                await expectsFallback(page, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' }, options)
            }
        })

        it('when the container holds raw text', async () => {
            for (const tag of ['textarea', 'title', 'script', 'style', 'noscript']) {
                await expectsFallback(`<${tag} class="c"><p class="s">a</p>b</${tag}><p>z</p>`, '.c', {})
            }
        })

        it('when the container is in MathML', async () => {
            for (const body of [
                '<math><mi class="c"><p class="s">a</p>x</mi></math>',
                '<math><mi><div class="c"><p class="s">a</p>x</div></mi></math>',
            ]) {
                await expectsFallback(body, '.c', { fromMarker: '.s' })
            }
        })

        it('when a marker selector has a combinator', async () => {
            await expectsFallback('<div class="c"><h1>t</h1><section><p class="s">a</p><p>b</p></section><p>c</p></div>', '.c', {
                fromMarker: 'section .s',
            })
        })

        it('when the container selector names the MathML element', async () => {
            await expectsFallback('<math><mi class="c"><p class="s">a</p>x</mi></math><p>z</p>', 'math > mi.c', { fromMarker: '.s' })
        })

        it('when a component before the range inserts content', async () => {
            for (const [selector, content] of [
                ['p.s', { after: [html('<u>O</u>')] }],
                ['section', { before: [html('<u>O</u>')] }],
            ] as const) {
                const options = { others: { other: { selector, content } }, othersFirst: true }
                await expectsFallback(page, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' }, options)
            }
        })

        it('when the container selector is a list', async () => {
            await expectsFallback(`<p class="x">x</p>${page}`, '.x, .c', { fromMarker: 'p.s', toMarker: 'hr.e' })
        })
    })

    it('uses the element path when the decision has several range components', async () => {
        const two = decision('.c', { fromMarker: 'p.s' })
        two.componentBehaviors.second = {
            metadata: { cssSelector: 'footer' },
            content: { replaceRange: { replaceWith: [html('<i>2</i>')] } },
        }
        const rewriter = new EndTagSpyRewriter()
        const result = await handleSurfaceComponents(ctx, new Response(page, { headers: { 'Content-Type': 'text/html' } }), two, rewriter)
        expect(await result.text()).toBe('<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i></div><footer><i>2</i></footer>')
        expect(rewriter.endTagCalls.length).toBeGreaterThan(2)
    })

    it('gives the same page as cutting element by element on random pages', async () => {
        let seed = 7
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
        const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T
        const tree = (depth: number): string => {
            let out = ''
            for (let i = 0, n = 1 + Math.floor(rnd() * 5); i < n; i++) {
                const r = rnd()
                if (r < 0.2) out += pick(['text ', 'a <b>b</b> ', '&amp; '])
                else if (r < 0.35) out += `<${pick(['img', 'br', 'hr', 'input'])}${rnd() < 0.4 ? ` class="${pick(['s', 'e', 'x'])}"` : ''}>`
                else if (r < 0.4) out += `<svg><path class="${pick(['s', 'e'])}"/><link class="${pick(['s', 'e'])}"></link></svg>`
                else if (depth > 0) {
                    const tag = pick(['div', 'p', 'span', 'section', 'ul', 'li', 'a', 'h2'])
                    const cls = pick(['s', 'e', 'x', 'c', ''])
                    out += `<${tag}${cls ? ` class="${cls}"` : ''}>${tree(depth - 1)}</${tag}>`
                } else out += 'leaf '
            }
            return out
        }
        for (let i = 0; i < 300; i++) {
            const container = pick(['div', 'div', 'div', 'textarea', 'mi'])
            const containerHtml = `<${container} class="c">${tree(3)}</${container}>`
            const body = `<body>${tree(2)}${container === 'mi' ? `<math>${containerHtml}</math>` : containerHtml}${rnd() < 0.3 ? `<article class="c">${tree(2)}</article>` : ''}${tree(1)}</body>`
            const range = {
                fromMarker: pick([undefined, '.s', 'p', 'h2', 'img']),
                toMarker: pick([undefined, undefined, '.e', 'hr', 'li']),
            }
            const otherSelector = pick(['.s', '.e', '.c', 'p', 'li'])
            const options = pick<Options>([
                {},
                { others: { other: { selector: otherSelector, content: { remove: true } } }, othersFirst: rnd() < 0.5 },
                {
                    others: {
                        other: {
                            selector: otherSelector,
                            content: { [pick(['append', 'prepend', 'before', 'after'])]: [html('<u>O</u>')] },
                        },
                    },
                    othersFirst: rnd() < 0.5,
                },
            ])
            const selector = pick(['.c', 'div', 'article', 'body'])
            const wrapped = await run(body, selector, range, options)
            const elementByElement = await run(body, selector, range, options, true)
            expect(wrapped.body, JSON.stringify({ body, selector, range, options })).toBe(elementByElement.body)
        }
    })
})
