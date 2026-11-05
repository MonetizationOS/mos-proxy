import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import handleSurfaceComponents, { applyComponents } from '../../src/stages/surfaceComponents'
import { combineSelectors, planRangeWrapper, splitSelectorList } from '../../src/stages/wrappedRange'
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
type Options = { others?: Others; othersFirst?: boolean; own?: Record<string, unknown> }
const html = (content: string) => ({ type: 'html' as const, content })

const decision = (
    selector: string,
    range: Range,
    { others = {}, othersFirst = false, own = {} }: Options = {},
): SurfaceDecisionResponse => {
    const rangeBehavior = {
        range: {
            metadata: { cssSelector: selector },
            content: { ...own, replaceRange: { replaceWith: [html('<i>NEW</i>')], ...range } },
        },
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

const transform = async (body: string, decisions: SurfaceDecisionResponse, elementByElement = false) => {
    const rewriter = new EndTagSpyRewriter()
    const response = new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    const result = elementByElement
        ? await applyComponents(ctx, response, decisions, rewriter, null)
        : await handleSurfaceComponents(ctx, response, decisions, rewriter)
    const path = elementByElement || !planRangeWrapper(ctx, decisions) ? 'elements' : rewriter.sessions > 2 ? 'fallback' : 'wrapper'
    return { body: await result.text(), endTagCalls: rewriter.endTagCalls, path }
}

/**
 * What the wrapper is expected to give, cut element by element: each range applied on its own ahead of the other
 * components, so what they insert inside a cut goes with it and a marker they remove still marks the cut. `excluded`
 * are containers the wrapper leaves alone.
 */
const expectedByElements = async (body: string, decisions: SurfaceDecisionResponse, excluded = '') => {
    const rest: SurfaceDecisionResponse['componentBehaviors'] = {}
    let current = body
    for (const [key, behavior] of Object.entries(decisions.componentBehaviors)) {
        const { replaceRange, ...content } = behavior.content ?? {}
        if (!replaceRange) {
            rest[key] = behavior
            continue
        }
        const cssSelector = splitSelectorList(behavior.metadata.cssSelector as string)
            .map((part) => part + excluded)
            .join(', ')
        const range = { ...decisions, componentBehaviors: { [key]: { metadata: { cssSelector }, content: { replaceRange } } } }
        current = (await transform(current, range, true)).body
        if (Object.keys(content).length) {
            rest[key] = { ...behavior, content }
        }
    }
    return (await transform(current, { ...decisions, componentBehaviors: rest }, true)).body
}

const run = (body: string, selector: string, range: Range, options?: Options, elementByElement = false) =>
    transform(body, decision(selector, range, options), elementByElement)

/** Runs the page through the wrapper and element by element, and expects the same output from both. */
const bothWays = async (body: string, selector: string, range: Range, options?: Options) => {
    const wrapped = await run(body, selector, range, options)
    const elementByElement = await run(body, selector, range, options, true)
    expect(wrapped.body).toBe(elementByElement.body)
    return { ...wrapped, elementByElement }
}

/** Runs the page through the wrapper alone, and expects it not to fall back. */
const wrapped = async (body: string, selector: string, range: Range, options?: Options) => {
    const result = await run(body, selector, range, options)
    expect(result.path).toBe('wrapper')
    return result.body
}

const page = '<div class="c"><h1>t</h1><p class="s">a</p><p>b</p><section><p>c</p></section><hr class="e"><p>d</p></div><footer>f</footer>'

describe('selector lists', () => {
    it('splits on top-level commas only', () => {
        expect(splitSelectorList('.a, div[title="x,y"] , :not(.b, .c)')).toEqual(['.a', 'div[title="x,y"]', ':not(.b, .c)'])
        expect(splitSelectorList("[data-x='a\\'s,'], .b")).toEqual(["[data-x='a\\'s,']", '.b'])
    })

    it('combines every part of both sides', () => {
        expect(combineSelectors('.a, .b', ' > ', 'p, hr')).toBe('.a > p, .a > hr, .b > p, .b > hr')
    })
})

describe('range replacement by wrapper', () => {
    it('cuts from the start marker to the end of the container with one callback', async () => {
        const { body, endTagCalls, elementByElement, path } = await bothWays(page, '.c', { fromMarker: 'p.s' })
        expect(body).toBe('<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i></div><footer>f</footer>')
        expect(path).toBe('wrapper')
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

    it('removes stray end tags of void elements inside the cut', async () => {
        const { body, endTagCalls } = await run('<div class="c"><p class="s">a</p><img src="x"></img><br></br><p>b</p></div>', '.c', {
            fromMarker: 'p.s',
        })
        expect(body).toBe('<div class="c"><p class="s">a</p><i>NEW</i></div>')
        expect(endTagCalls).toEqual(['div', 'p'])
    })

    it('cuts after a start marker that holds another with one callback', async () => {
        const { body, endTagCalls } = await bothWays('<div class="c"><div class="s"><p class="s">a</p><p>b</p></div><p>c</p></div>', '.c', {
            fromMarker: '.s',
        })
        expect(body).toBe('<div class="c"><div class="s"><p class="s">a</p><p>b</p></div><i>NEW</i></div>')
        expect(endTagCalls.sort()).toEqual(['div', 'div'])
    })

    it('ignores an end marker nested in the start marker', async () => {
        const { body, path } = await bothWays('<div class="c"><div class="s"><hr class="e"></div><p>b</p><hr class="e"></div>', '.c', {
            fromMarker: '.s',
            toMarker: '.e',
        })
        expect(body).toBe('<div class="c"><div class="s"><hr class="e"></div><i>NEW</i><hr class="e"></div>')
        expect(path).toBe('wrapper')
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
            for (const othersFirst of [false, true]) {
                const body = await wrapped(page, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' }, { others: around, othersFirst })
                expect(body).toBe(
                    '<div class="c"><b>P</b><h1>t</h1><u>B</u><p class="s">a</p><u>F</u><i>NEW</i><s>B</s><hr class="e"><s>F</s><p>d</p><b>A</b></div><footer>f</footer>',
                )
            }
        })

        it('keep what they append to a container cut to its end', async () => {
            const { body } = await bothWays(page, '.c', { fromMarker: 'p.s' }, { others: { container: around.container as never } })
            expect(body).toBe('<div class="c"><b>P</b><h1>t</h1><p class="s">a</p><i>NEW</i><b>A</b></div><footer>f</footer>')
        })

        it('put what they prepend to a container cut from its top before the replacement', async () => {
            for (const othersFirst of [false, true]) {
                const others = { container: around.container as never }
                const body = await wrapped(page, '.c', { toMarker: 'hr.e' }, { others, othersFirst })
                expect(body).toBe('<div class="c"><b>P</b><i>NEW</i><hr class="e"><p>d</p><b>A</b></div><footer>f</footer>')
            }
        })

        it('still apply to the content that stays', async () => {
            const others = { heading: { selector: 'h1', content: { append: [html('<em>x</em>')] } } }
            const { body } = await bothWays(page, '.c', { fromMarker: 'p.s' }, { others })
            expect(body).toBe('<div class="c"><h1>t<em>x</em></h1><p class="s">a</p><i>NEW</i></div><footer>f</footer>')
        })

        it('lose what they insert inside the cut, whatever their order', async () => {
            const others: Others = {
                inside: { selector: 'section', content: { before: [html('<u>O</u>')], prepend: [html('<u>O</u>')] } },
                nested: { selector: 'section p', content: { after: [html('<u>O</u>')] } },
            }
            for (const othersFirst of [false, true]) {
                const body = await wrapped(page, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' }, { others, othersFirst })
                expect(body).toBe('<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i><hr class="e"><p>d</p></div><footer>f</footer>')
            }
        })

        it('do not move the cut when they remove a marker', async () => {
            for (const othersFirst of [false, true]) {
                const others = {
                    start: { selector: 'p.s', content: { remove: true } },
                    end: { selector: 'hr.e', content: { remove: true } },
                }
                const body = await wrapped(page, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' }, { others, othersFirst })
                expect(body).toBe('<div class="c"><h1>t</h1><i>NEW</i><p>d</p></div><footer>f</footer>')
            }
        })
    })

    describe('content on the range component', () => {
        it('lands around the cut', async () => {
            const own = { prepend: [html('<b>P</b>')], append: [html('<b>A</b>')], before: [html('<b>B</b>')], after: [html('<b>F</b>')] }
            expect(await wrapped(page, '.c', { toMarker: 'hr.e' }, { own })).toBe(
                '<b>B</b><div class="c"><b>P</b><i>NEW</i><hr class="e"><p>d</p><b>A</b></div><b>F</b><footer>f</footer>',
            )
        })

        it('removes the container with the range', async () => {
            const own = { remove: true, after: [html('<b>F</b>')] }
            expect(await wrapped(page, '.c', { fromMarker: 'p.s' }, { own })).toBe('<b>F</b><footer>f</footer>')
        })
    })

    describe('leaves a container alone', () => {
        it('when it holds raw text', async () => {
            for (const tag of ['textarea', 'title', 'script', 'style', 'noscript']) {
                const body = `<${tag} class="c"><p class="s">a</p>b</${tag}><p>z</p>`
                expect(await wrapped(body, '.c', {})).toBe(body)
            }
        })

        it('when it is in MathML', async () => {
            for (const body of [
                '<math><mi class="c"><p class="s">a</p>x</mi></math>',
                '<math><mi><div class="c"><p class="s">a</p>x</div></mi></math>',
                '<math class="c"><mi class="s">a</mi><mi>x</mi></math>',
            ]) {
                expect(await wrapped(body, '.c', { fromMarker: '.s' })).toBe(body)
            }
            expect(await wrapped('<math><mi class="c">x</mi></math><p>z</p>', 'math > mi.c', {})).toBe(
                '<math><mi class="c">x</mi></math><p>z</p>',
            )
        })

        it('but still cuts the containers after it', async () => {
            const body = '<math><mi class="c"><p class="s">a</p>x</mi></math><div class="c"><p class="s">a</p>b</div>'
            expect(await wrapped(body, '.c', { fromMarker: '.s' })).toBe(
                '<math><mi class="c"><p class="s">a</p>x</mi></math><div class="c"><p class="s">a</p><i>NEW</i></div>',
            )
        })
    })

    describe('nested containers', () => {
        it('cut only the outermost', async () => {
            const body = '<div class="c"><p>a</p><div class="c"><p>b</p></div><p class="s">c</p><p>d</p></div>'
            const { body: out, path } = await bothWays(body, '.c', { fromMarker: 'p.s' })
            expect(out).toBe('<div class="c"><p>a</p><div class="c"><p>b</p></div><p class="s">c</p><i>NEW</i></div>')
            expect(path).toBe('wrapper')
        })

        it('cut only the outermost, holding a start marker in the math', async () => {
            const body = '<div class="c"><math class="s"><mi class="c">x</mi></math><p>b</p></div>'
            const { body: out, path } = await bothWays(body, '.c', { fromMarker: '.s' })
            expect(out).toBe('<div class="c"><math class="s"><mi class="c">x</mi></math><i>NEW</i></div>')
            expect(path).toBe('wrapper')
        })
    })

    it('cuts each container of a selector list', async () => {
        const body = `<section class="x"><p class="s">a</p><p>b</p></section>${page}`
        const { body: out, path } = await bothWays(body, '.x, .c', { fromMarker: 'p.s', toMarker: 'hr.e' })
        expect(out).toBe(
            '<section class="x"><p class="s">a</p><i>NEW</i></section><div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i><hr class="e"><p>d</p></div><footer>f</footer>',
        )
        expect(path).toBe('wrapper')
    })

    it('starts the range at the first marker of a list', async () => {
        const { body, path } = await bothWays(page, '.c', { fromMarker: 'section, p.s', toMarker: 'footer, hr' })
        expect(body).toBe('<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i><hr class="e"><p>d</p></div><footer>f</footer>')
        expect(path).toBe('wrapper')
    })

    describe('several range components', () => {
        const second = (selector: string, range: Range = {}): Others => ({
            second: { selector, content: { replaceRange: { replaceWith: [html('<i>2</i>')], ...range } } },
        })

        it('cut each range', async () => {
            const { body, path } = await bothWays(page, '.c', { fromMarker: 'p.s' }, { others: second('footer') })
            expect(body).toBe('<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i></div><footer><i>2</i></footer>')
            expect(path).toBe('wrapper')
        })

        it('cut a range nested in another', async () => {
            for (const [range, expected] of [
                [{ toMarker: 'hr.e' }, '<div class="c"><i>NEW</i><hr class="e"><p>d</p></div>'],
                [{ fromMarker: 'p.s' }, '<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i></div>'],
                [{ fromMarker: 'h1' }, '<div class="c"><h1>t</h1><i>NEW</i></div>'],
            ] as const) {
                const { body, path } = await bothWays(page, '.c', range, { others: second('section') })
                expect(body).toBe(`${expected}<footer>f</footer>`)
                expect(path).toBe('wrapper')
            }
            const kept = await bothWays(page, '.c', { toMarker: 'section' }, { others: second('section', { fromMarker: 'p' }) })
            expect(kept.body).toBe(
                '<div class="c"><i>NEW</i><section><p>c</p><i>2</i></section><hr class="e"><p>d</p></div><footer>f</footer>',
            )
        })
    })

    describe('falls back to cutting element by element', () => {
        const expectsFallback = async (body: string, selector: string, range: Range, options?: Options) => {
            const { endTagCalls, elementByElement, path } = await bothWays(body, selector, range, options)
            expect(path).toBe('fallback')
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

        it('when a marker is a direct child of a nested container', async () => {
            await expectsFallback('<div class="c"><p>a</p><div class="c"><p class="s">b</p><p>c</p></div></div>', '.c', {
                fromMarker: 'p.s',
            })
            await expectsFallback('<div class="c"><p>a</p><div class="c"><hr class="e"><p>c</p></div></div>', '.c', { toMarker: 'hr.e' })
        })

        it('when a nested container is a marker', async () => {
            await expectsFallback('<div class="c"><p>a</p><div class="c s"><p>b</p></div><p>c</p></div>', '.c', { fromMarker: '.s' })
        })

        it('when an element is the container of two ranges', async () => {
            const others = { second: { selector: 'div', content: { replaceRange: { fromMarker: 'h1' } } } }
            await expectsFallback(page, '.c', { fromMarker: 'p.s' }, { others })
        })

        it('when the container of one range is a marker of another', async () => {
            const others = { second: { selector: 'body', content: { replaceRange: { fromMarker: '.c' } } } }
            await expectsFallback(`<body>${page}</body>`, '.c', { toMarker: 'hr.e' }, { others })
        })
    })

    it('cuts element by element when a marker selector has a combinator', async () => {
        const body = '<div class="c"><h1>t</h1><section><p class="s">a</p><p>b</p></section><p>c</p></div>'
        const { path } = await bothWays(body, '.c', { fromMarker: 'section .s' })
        expect(path).toBe('elements')
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
        // No element any range selector matches, so the only container in MathML is the `mi`
        const mathTree = () => `<mo class="${pick(['s', 'e', 'x'])}">x</mo><mn>1</mn>`
        const insert = () => ({ [pick(['append', 'prepend', 'before', 'after'])]: [html('<u>O</u>')] })
        const counts = { wrapper: 0, fallback: 0, elements: 0 }
        for (let i = 0; i < 300; i++) {
            const container = pick(['div', 'div', 'div', 'textarea', 'mi'])
            const containerHtml = `<${container} class="c">${container === 'mi' ? mathTree() : tree(3)}</${container}>`
            const body = `<body>${tree(2)}${container === 'mi' ? `<math>${containerHtml}</math>` : containerHtml}${rnd() < 0.3 ? `<article class="c">${tree(2)}</article>` : ''}${tree(1)}</body>`
            const range = {
                fromMarker: pick([undefined, '.s', 'p', 'h2', 'img', 'h2, .s']),
                toMarker: pick([undefined, undefined, '.e', 'hr', 'li']),
            }
            const otherSelector = pick(['.s', '.e', '.c', 'p', 'li'])
            const others: Others = pick<Others>([
                {},
                { other: { selector: otherSelector, content: { remove: true } } },
                { other: { selector: otherSelector, content: insert() } },
            ])
            if (rnd() < 0.3) {
                others.second = {
                    selector: pick(['section', 'ul', 'li', 'span.x', 'h2']),
                    content: {
                        replaceRange: {
                            fromMarker: pick([undefined, '.s', 'p']),
                            toMarker: pick([undefined, '.e']),
                            replaceWith: [html('<i>2</i>')],
                        },
                    },
                }
            }
            const options: Options = {
                others,
                othersFirst: rnd() < 0.5,
                own: rnd() < 0.2 ? (rnd() < 0.2 ? { remove: true } : insert()) : {},
            }
            const selector = pick(['.c', 'div', 'article', 'body', '.c, article', 'article, div', 'section, .c'])
            const decisions = decision(selector, range, options)
            const result = await transform(body, decisions)
            counts[result.path as keyof typeof counts]++
            const expected =
                result.path === 'fallback'
                    ? (await transform(body, decisions, true)).body
                    : await expectedByElements(body, decisions, ':not(textarea):not(mi)')
            expect(result.body, JSON.stringify({ body, selector, range, options, path: result.path })).toBe(expected)
        }
        expect(counts.wrapper).toBeGreaterThan(counts.fallback)
    })
})
