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
    // Only the element path selects every element in a container
    const fellBack = rewriter.selectors.some((selector) => selector.endsWith(' *'))
    const path = elementByElement || !planRangeWrapper(ctx, decisions) ? 'elements' : fellBack ? 'fallback' : 'wrapper'
    // A pass that selects every element finds the open elements around a nested start marker
    const spliced = path === 'wrapper' && rewriter.selectors.includes('*')
    return { body: await result.text(), endTagCalls: rewriter.endTagCalls, path, spliced }
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
const nested = '<div class="c"><h1>t</h1><section><div><p class="s">a</p><p>b</p></div><p>c</p></section><p>d</p></div><footer>f</footer>'

describe('selector lists', () => {
    it('splits on top-level commas only', () => {
        expect(splitSelectorList('.a, div[title="x,y"] , :not(.b, .c)')).toEqual(['.a', 'div[title="x,y"]', ':not(.b, .c)'])
        expect(splitSelectorList("[data-x='a\\'s,'], .b")).toEqual(["[data-x='a\\'s,']", '.b'])
    })

    it('splits whatever the whitespace around the commas', () => {
        expect(splitSelectorList('.a,.b')).toEqual(['.a', '.b'])
        expect(splitSelectorList('  .a   ,\n\t.b  ')).toEqual(['.a', '.b'])
    })

    it('keeps a list with an empty part invalid', () => {
        expect(combineSelectors('.a,', ' ', 'p')).toBe('.a, p')
        expect(combineSelectors('.a', ' > ', 'p,,hr')).toBe('.a > p,,hr')
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
        it('cut each by its own markers', async () => {
            const body = '<div class="c"><p>a</p><div class="c"><p>b</p></div><p class="s">c</p><p>d</p></div>'
            const { body: out, path } = await bothWays(body, '.c', { fromMarker: 'p.s' })
            expect(out).toBe('<div class="c"><p>a</p><div class="c"><p>b</p></div><p class="s">c</p><i>NEW</i></div>')
            expect(path).toBe('wrapper')
        })

        it('cut around one in the math', async () => {
            const body = '<div class="c"><math class="s"><mi class="c">x</mi></math><p>b</p></div>'
            const { body: out, path } = await bothWays(body, '.c', { fromMarker: '.s' })
            expect(out).toBe('<div class="c"><math class="s"><mi class="c">x</mi></math><i>NEW</i></div>')
            expect(path).toBe('fallback')
        })

        it('cut element by element when an inner one is left without its end tag', async () => {
            for (const [body, range, expected] of [
                [
                    '<ul class="c"><li class="c">x</ul><ul class="c"><li>y</li></ul>',
                    {},
                    '<ul class="c"><i>NEW</i><li class="c"><i>NEW</i></ul><ul class="c"><i>NEW</i></ul>',
                ],
                [
                    '<div class="c"><p class="c">x</div><p>after</p>',
                    { fromMarker: 'p.s' },
                    '<div class="c"><p class="c">x</div><p>after</p>',
                ],
                [
                    '<div class="c"><p class="c">x</div><div class="c"><p class="s">a</p>b</div>',
                    { fromMarker: 'p.s' },
                    '<div class="c"><p class="c">x</div><div class="c"><p class="s">a</p><i>NEW</i></div>',
                ],
                [
                    '<ul class="c"><li class="c">x<li class="s">y</li><li>z</li></ul>',
                    { fromMarker: '.s' },
                    '<ul class="c"><li class="c">x<li class="s">y</li><i>NEW</i></ul>',
                ],
            ] as const) {
                const { body: out, path } = await bothWays(body, '.c', range)
                expect(out).toBe(expected)
                expect(path).toBe('fallback')
            }
        })

        it('cut around a direct child in the cut, which keeps its own replacement', async () => {
            const { body, path } = await bothWays('<div class="c">x<div class="c">y<hr>z</div>w</div>', '.c', { toMarker: 'hr' })
            expect(body).toBe('<div class="c"><i>NEW</i><div class="c"><i>NEW</i><hr>z</div></div>')
            expect(path).toBe('wrapper')
        })

        it('cut by the markers directly in the nested one', async () => {
            const { body, path } = await bothWays('<div class="c"><p>a</p><div class="c"><hr class="e"><p>c</p></div></div>', '.c', {
                toMarker: 'hr.e',
            })
            expect(body).toBe('<div class="c"><i>NEW</i><div class="c"><i>NEW</i><hr class="e"><p>c</p></div></div>')
            expect(path).toBe('wrapper')
        })

        it('cut a nested one holding the start marker, and leave the outer one', async () => {
            const body = '<div class="c"><p>a</p><div class="c"><p class="s">b</p><p>c</p></div><p>d</p></div>'
            const { body: out, path } = await bothWays(body, '.c', { fromMarker: 'p.s' })
            expect(out).toBe('<div class="c"><p>a</p><div class="c"><p class="s">b</p><i>NEW</i></div><p>d</p></div>')
            expect(path).toBe('wrapper')
        })

        it('cut a nested one deeper in what the outer one keeps', async () => {
            const body =
                '<div class="c"><section><div class="c"><p>y</p><p class="s">s</p><p>z</p></div></section><p class="s">a</p><p>b</p></div>'
            const { body: out, path } = await bothWays(body, '.c', { fromMarker: 'p.s' })
            expect(out).toBe(
                '<div class="c"><section><div class="c"><p>y</p><p class="s">s</p><i>NEW</i></div></section><p class="s">a</p><i>NEW</i></div>',
            )
            expect(path).toBe('wrapper')
        })

        it('end the outer cut at a nested one that is its end marker', async () => {
            const { body } = await bothWays('<div><p class="s">a</p>b <div class="e">c</div>d</div>', 'div', {
                fromMarker: '.s',
                toMarker: '.e',
            })
            expect(body).toBe('<div><p class="s">a</p><i>NEW</i><div class="e">c</div>d</div>')
        })

        it('keep what holds a nested one deeper in the cut, element by element', async () => {
            const { body, path } = await bothWays('<div class="c">x<section>s<div class="c">y</div>t</section>w</div>', '.c', {})
            expect(body).toBe('<div class="c"><i>NEW</i><section><div class="c"><i>NEW</i></div></section></div>')
            expect(path).toBe('fallback')
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

    it.each(['.x,.c', '.x   ,   .c'])('cuts each container of the selector list %j', async (selector) => {
        const body = `<section class="x"><p class="s">a</p><p>b</p></section>${page}`
        const { body: out, path } = await bothWays(body, selector, { fromMarker: 'p.x,p.s', toMarker: 'hr.e   ,   hr.x' })
        expect(out).toBe(
            '<section class="x"><p class="s">a</p><i>NEW</i></section><div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i><hr class="e"><p>d</p></div><footer>f</footer>',
        )
        expect(path).toBe('wrapper')
    })

    it.each([
        ['.x,,.c', 'p.s'],
        ['.c,', 'p.s'],
        ['.c', 'p.s,'],
    ])('leaves the page alone when a selector list has an empty part (%j, %j)', async (selector, fromMarker) => {
        const { body } = await bothWays(page, selector, { fromMarker })
        expect(body).toBe(page)
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

        it('when the end marker is not a direct child of the container', async () => {
            await expectsFallback('<div class="c"><p class="s">a</p><p>b</p><section><hr class="e"><p>c</p></section></div>', '.c', {
                fromMarker: 'p.s',
                toMarker: 'hr.e',
            })
        })

        it('when the start marker is nested and the decision has another range', async () => {
            const others = { second: { selector: 'footer', content: { replaceRange: {} } } }
            await expectsFallback(nested, '.c', { fromMarker: 'p.s' }, { others })
        })

        it('when the start marker is nested in MathML', async () => {
            await expectsFallback('<div class="c"><math><mi class="s">x</mi><mn>1</mn></math><p>b</p></div>', '.c', { fromMarker: '.s' })
        })

        it('when the start marker is nested in an SVG container', async () => {
            await expectsFallback('<svg class="c"><g><path/><circle class="s"/></g><rect/></svg>', '.c', { fromMarker: '.s' })
        })

        it('when another component removes what holds a nested start marker', async () => {
            const others = { section: { selector: 'section', content: { remove: true } } }
            await expectsFallback(nested, '.c', { fromMarker: 'p.s' }, { others })
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

    describe('nested start marker', () => {
        const spliced = async (body: string, selector: string, range: Range, options?: Options) => {
            const result = await bothWays(body, selector, range, options)
            expect(result.path).toBe('wrapper')
            expect(result.spliced).toBe(true)
            return result
        }

        it('cuts to the end of the container, keeping the end tags of what holds the marker', async () => {
            const { body, endTagCalls, elementByElement } = await spliced(nested, '.c', { fromMarker: 'p.s' })
            expect(body).toBe('<div class="c"><h1>t</h1><section><div><p class="s">a</p><i>NEW</i></div></section></div><footer>f</footer>')
            expect(elementByElement.endTagCalls.length).toBeGreaterThan(endTagCalls.length)
        })

        it('cuts up to an end marker that is a direct child', async () => {
            const body = nested.replace('<p>d</p>', '<p>x</p><hr class="e"><p>d</p>')
            const result = await spliced(body, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' })
            expect(result.body).toBe(
                '<div class="c"><h1>t</h1><section><div><p class="s">a</p><i>NEW</i></div></section><hr class="e"><p>d</p></div><footer>f</footer>',
            )
        })

        it('cuts after a void or self-closing start marker', async () => {
            const { body } = await spliced('<div class="c"><div><img class="s"><p>b</p></div><p>c</p></div>', '.c', { fromMarker: '.s' })
            expect(body).toBe('<div class="c"><div><img class="s"><i>NEW</i></div></div>')
            const svg = await spliced('<div class="c"><svg><g><path class="s"/><circle/></g><rect/></svg><p>b</p></div>', '.c', {
                fromMarker: '.s',
            })
            expect(svg.body).toBe('<div class="c"><svg><g><path class="s"/><i>NEW</i></g></svg></div>')
        })

        it('cuts each container', async () => {
            const { body } = await spliced(`${nested}${nested}`, '.c', { fromMarker: 'p.s' })
            const once = '<div class="c"><h1>t</h1><section><div><p class="s">a</p><i>NEW</i></div></section></div><footer>f</footer>'
            expect(body).toBe(once + once)
        })

        it('cuts a page mixing nested and direct start markers', async () => {
            const { body } = await spliced(`${page}${nested}`, '.c', { fromMarker: 'p.s' })
            expect(body).toBe(
                '<div class="c"><h1>t</h1><p class="s">a</p><i>NEW</i></div><footer>f</footer><div class="c"><h1>t</h1><section><div><p class="s">a</p><i>NEW</i></div></section></div><footer>f</footer>',
            )
        })

        it('closes an ancestor whose end tag the page left out', async () => {
            const body = '<div class="c"><p>a <b class="s">x</b> y<p>z</div><p>after</p>'
            const { body: out, path } = await run(body, '.c', { fromMarker: '.s' })
            expect(out).toBe('<div class="c"><p>a <b class="s">x</b><i>NEW</i></p></div><p>after</p>')
            expect(path).toBe('wrapper')
            // Removing the `p` left open also takes the end tag that closes it
            expect((await run(body, '.c', { fromMarker: '.s' }, {}, true)).body).toBe(
                '<div class="c"><p>a <b class="s">x</b><i>NEW</i><p>after</p>',
            )
        })

        describe('other components', () => {
            const around: Others = {
                container: { selector: '.c', content: { prepend: [html('<b>P</b>')], append: [html('<b>A</b>')] } },
                start: { selector: 'p.s', content: { before: [html('<u>B</u>')], after: [html('<u>F</u>')] } },
                holder: {
                    selector: 'section',
                    content: {
                        before: [html('<s>B</s>')],
                        prepend: [html('<s>P</s>')],
                        append: [html('<s>A</s>')],
                        after: [html('<s>F</s>')],
                    },
                },
            }

            it('keep what they insert before the cut, and lose what they insert inside it', async () => {
                for (const othersFirst of [false, true]) {
                    const body = await wrapped(nested, '.c', { fromMarker: 'p.s' }, { others: around, othersFirst })
                    expect(body).toBe(
                        '<div class="c"><b>P</b><h1>t</h1><s>B</s><section><s>P</s><div><u>B</u><p class="s">a</p><u>F</u><i>NEW</i></div></section><b>A</b></div><footer>f</footer>',
                    )
                }
            })

            it('do not move the cut when they remove a marker', async () => {
                const body = nested.replace('<p>d</p>', '<hr class="e"><p>d</p>')
                for (const othersFirst of [false, true]) {
                    const others = {
                        start: { selector: 'p.s', content: { remove: true } },
                        end: { selector: 'hr.e', content: { remove: true } },
                    }
                    expect(await wrapped(body, '.c', { fromMarker: 'p.s', toMarker: 'hr.e' }, { others, othersFirst })).toBe(
                        '<div class="c"><h1>t</h1><section><div><i>NEW</i></div></section><p>d</p></div><footer>f</footer>',
                    )
                }
            })
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
        let unclosed = false
        // Left open, so the end tag of what holds it closes it. Never a start marker: one left open never gets what
        // is inserted after it.
        let openTags = ['p', 'li']
        const tree = (depth: number, parent = ''): string => {
            let out = ''
            for (let i = 0, n = 1 + Math.floor(rnd() * 5); i < n; i++) {
                const r = rnd()
                const open = openTags.length ? pick(openTags) : parent
                // In one of its own kind, the parent's end tag would close it and leave the parent open
                if (i === n - 1 && depth > 0 && open !== parent && rnd() < 0.1) {
                    unclosed = true
                    out += `<${open}${rnd() < 0.4 ? ` class="${pick(['e', 'x', 'c'])}"` : ''}>${tree(depth - 1, open)}`
                } else if (r < 0.2) out += pick(['text ', 'a <b>b</b> ', '&amp; '])
                else if (r < 0.35) out += `<${pick(['img', 'br', 'hr', 'input'])}${rnd() < 0.4 ? ` class="${pick(['s', 'e', 'x'])}"` : ''}>`
                else if (r < 0.4) out += `<svg><path class="${pick(['s', 'e'])}"/><link class="${pick(['s', 'e'])}"></link></svg>`
                else if (depth > 0) {
                    const tag = pick(['div', 'p', 'span', 'section', 'ul', 'li', 'a', 'h2'])
                    const cls = pick(['s', 'e', 'x', 'c', ''])
                    out += `<${tag}${cls ? ` class="${cls}"` : ''}>${tree(depth - 1, tag)}</${tag}>`
                } else out += 'leaf '
            }
            return out
        }
        // No element any range selector matches, so the only container in MathML is the `mi`
        const mathTree = () => `<mo class="${pick(['s', 'e', 'x'])}">x</mo><mn>1</mn>`
        const insert = () => ({ [pick(['append', 'prepend', 'before', 'after'])]: [html('<u>O</u>')] })
        /**
         * A nested start marker's cut also takes what other components insert at the end of what holds it, and closes
         * what holds it as the page reads with their inserts: one in `svg` takes the `path` after it out of SVG, where
         * `<path/>` stays open. Where the page left an element open in the cut, the element path removing it also takes
         * the end tag that closes it, so what is inserted at that end tag moves; the cut closes what was left open.
         */
        const afterReplacement = /(<i>NEW<\/i>)((?:<\/[a-z0-9]+>|<u>O<\/u>)*)/g
        const normalized = (body: string, spliced: boolean) =>
            (unclosed ? body.replaceAll('<u>O</u>', '') : body).replace(afterReplacement, (_, replacement: string, run: string) => {
                const kept = spliced ? run.replaceAll('<u>O</u>', '').replaceAll('</path>', '') : run
                return replacement + (unclosed ? kept.replace(/<\/[a-z0-9]+>/g, '') : kept)
            })
        const counts = { wrapper: 0, spliced: 0, fallback: 0, elements: 0 }
        for (let i = 0; i < 300; i++) {
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
            // Removing an element left open also removes what follows it up to the end tag that closes it
            const removes = !!others.second || JSON.stringify(options).includes('"remove"')
            unclosed = false
            openTags = removes ? [] : range.fromMarker === 'p' ? ['li'] : ['p', 'li']
            const container = pick(['div', 'div', 'div', 'textarea', 'mi'])
            const containerHtml = `<${container} class="c">${container === 'mi' ? mathTree() : tree(3)}</${container}>`
            const extraTag = pick(['article', 'div'])
            const extra = rnd() < 0.3 ? `<${extraTag} class="c">${tree(2)}</${extraTag}>` : ''
            const body = `<body>${tree(2)}${container === 'mi' ? `<math>${containerHtml}</math>` : containerHtml}${extra}${tree(1)}</body>`

            const result = await transform(body, decisions)
            counts[result.spliced ? 'spliced' : (result.path as keyof typeof counts)]++
            const expected =
                result.path === 'fallback'
                    ? (await transform(body, decisions, true)).body
                    : await expectedByElements(body, decisions, ':not(textarea):not(mi)')
            const context = JSON.stringify({ body, selector, range, options, path: result.path, spliced: result.spliced })
            if (result.path === 'wrapper' && (result.spliced || unclosed)) {
                expect(normalized(result.body, result.spliced), context).toBe(normalized(expected, result.spliced))
            } else {
                expect(result.body, context).toBe(expected)
            }
        }
        expect(counts.wrapper + counts.spliced).toBeGreaterThan(counts.fallback)
        expect(counts.spliced).toBeGreaterThan(0)
    })
})
