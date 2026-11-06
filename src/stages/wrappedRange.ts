import type { ElementHandlers, HtmlRewriterAdapter, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import { renderElement } from './elements'
import { isVoidElement } from './voidElements'

type Handler = { selector: string; handler: ElementHandlers }

// Their content is text, so a wrapper tag inserted into it is never parsed as a tag
const RAW_TEXT_ELEMENTS = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'style', 'textarea', 'title', 'xmp'])

const withoutNested = (selector: string) => selector.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]|\([^)]*\)/g, '')
// One compound selector, so `${container} > ${marker}` only matches a direct child
const isCompound = (selector: string) => !/[\s>+~]/.test(withoutNested(selector.trim()))

/** The top-level parts of a selector list. */
export const splitSelectorList = (selector: string): string[] => {
    const parts: string[] = []
    let nesting = 0
    let quote = ''
    let start = 0
    for (let i = 0; i < selector.length; i++) {
        const char = selector[i]
        if (char === '\\') {
            i++
        } else if (quote) {
            quote = char === quote ? '' : quote
        } else if (char === '"' || char === "'") {
            quote = char
        } else if (char === '(' || char === '[') {
            nesting++
        } else if (char === ')' || char === ']') {
            nesting--
        } else if (char === ',' && nesting === 0) {
            parts.push(selector.slice(start, i).trim())
            start = i + 1
        }
    }
    parts.push(selector.slice(start).trim())
    return parts
}

/** `${container}${combinator}${inner}` for every pair of parts, so a list on either side keeps the combinator. */
export const combineSelectors = (container: string, combinator: ' ' | ' > ', inner: string) => {
    const outers = splitSelectorList(container)
    const inners = splitSelectorList(inner)
    // An empty part (`.a,,.b`, `.a,`) is invalid; kept as is so the rewriter still rejects it
    if (outers.includes('') || inners.includes('')) {
        return `${container}${combinator}${inner}`
    }
    return outers.flatMap((outer) => inners.map((part) => `${outer}${combinator}${part}`)).join(', ')
}

export type RangeWrapper = {
    componentKeys: string[]
    /** Pass 1, ahead of every other component: split each container into `<tag>` segments. */
    handlers: Handler[]
    /** Pass 2: drop the segment holding each range and put its replacement there; unwrap the rest. */
    unwrap: Handler[]
    wrapped: () => number
    /** Pass 1 met a page the wrapper can't cut, so the caller must redo it element by element. */
    unsupported: () => boolean
    fail: () => void
    /** Start markers pass 1 found nested in their container, each cut by `splice` before pass 2. */
    nested: () => number
    /** Cuts the ranges of nested start markers out of pass 1's output, or null when the page must be redone element by element. */
    splice: (page: Uint8Array<ArrayBuffer>, rewriter: HtmlRewriterAdapter, headers: Headers) => Promise<Uint8Array<ArrayBuffer> | null>
}

type RangeState = {
    depth: number
    // `inStart`: a start marker nested in the first one doesn't start the range again
    phase: 'scanning' | 'inStart' | 'open' | 'closed'
    // Set by a `>` handler for the check on the same element, which runs after it
    directStart: boolean
    directEnd: boolean
    // The start marker was nested, so the range is cut by `splice`
    nested: boolean
    // The container isn't HTML, so a fragment of it can't be parsed on its own
    foreign: boolean
}

// Starts every sentinel; pages hardly ever hold it
const MARK = 1
const COMMENT_OPEN = 4
const COMMENT_CLOSE = 3

/**
 * Cuts each range by splitting its container into wrapper elements in one pass and removing the one that holds the
 * range in the next, so the cut costs one callback instead of one per element. The split only balances when both
 * markers are direct children of the outermost container. A nested start marker of the only range instead gets
 * sentinels around it and its replacement, and `splice` cuts the bytes from there to the end marker or the container's
 * end, putting back the end tags of the elements the start marker sits in. Any other nested marker makes the page
 * unsupported. What other components insert inside the cut is removed with it, and a marker removed by another
 * component still marks the cut. A container holding raw text, or inside `math`, is left alone.
 */
export const planRangeWrapper = (ctx: HtmlStageContext, decisions: SurfaceDecisionResponse): RangeWrapper | null => {
    const ranges = Object.entries(decisions.componentBehaviors).flatMap(([componentKey, behavior]) => {
        const replaceRange = behavior.content?.replaceRange
        const container = behavior.metadata.cssSelector
        // The component path skips `:last-child` containers
        return replaceRange && container && !container.includes(':last-child') ? [{ componentKey, replaceRange, container }] : []
    })
    if (!ranges.length) {
        return null
    }
    for (const { replaceRange } of ranges) {
        const { fromMarker, toMarker } = replaceRange
        if (fromMarker && toMarker && fromMarker === toMarker) {
            return null
        }
        for (const marker of [fromMarker, toMarker]) {
            if (marker && !splitSelectorList(marker).every(isCompound)) {
                return null
            }
        }
    }

    const nonce = Math.random().toString(36).slice(2, 10)
    const html = { html: true }

    let unsupported = false
    let wrapped = 0
    let nested = 0
    const sentinel = (index: number, kind: 'o' | 'c' | 's' | 'r' | 'e') => `${String.fromCharCode(MARK)}${nonce}-${index}-${kind}`
    const comment = (index: number, kind: 's' | 'r' | 'e') => `<!--${sentinel(index, kind)}-->`
    // Ranges whose container handler has run for the current element, cleared once its marker handlers have run
    let atContainer = 0
    // Open `math` and `svg` elements. The rewriter mismatches the wrapper's end tags inside MathML, and `splice` reads
    // the kept prefix as HTML, which misreads SVG's self-closing tags.
    const foreign = { math: 0, svg: 0 }
    const foreignTag = (element: RewriterElement) => {
        const tag = element.tagName.toLowerCase()
        return tag === 'math' || tag === 'svg' ? tag : null
    }

    // Only the last end tag callback registered on an element runs, so one registered on `math` or `svg` keeps its count
    const onEnd = (element: RewriterElement, callback: () => void) => {
        const tag = foreignTag(element)
        element.onEndTag?.(
            tag
                ? () => {
                      foreign[tag]--
                      callback()
                  }
                : callback,
        )
    }

    const handlers: Handler[] = (['math', 'svg'] as const).map((tag) => ({
        selector: tag,
        handler: {
            element(element: RewriterElement) {
                foreign[tag]++
                try {
                    element.onEndTag?.(() => {
                        foreign[tag]--
                    })
                } catch {
                    // Self-closing, so nothing is inside it
                    foreign[tag]--
                }
            },
        },
    }))
    const markers: Handler[] = []
    const cleanups: Handler[] = []
    const unwrap: Handler[] = []

    ranges.forEach(({ replaceRange, container }, index) => {
        const { fromMarker, toMarker } = replaceRange
        const tag = `mos-range-${nonce}-${index}`
        const cut = `<${tag}>`
        const keep = `<${tag} data-keep>`
        const close = `</${tag}>`
        const replacement = (replaceRange.replaceWith ?? []).map((item) => renderElement(ctx, item))
        const state: RangeState = { depth: 0, phase: 'closed', directStart: false, directEnd: false, nested: false, foreign: false }

        handlers.push({
            selector: container,
            handler: {
                element(element: RewriterElement) {
                    // The same element holding two ranges would need two end tag callbacks
                    unsupported ||= atContainer++ > 0
                    if (isVoidElement(element)) {
                        return
                    }
                    if (!element.onEndTag) {
                        unsupported = true
                        return
                    }
                    if (state.depth > 0) {
                        // Only the outermost container is cut; counting this one marks the markers in it as nested
                        try {
                            onEnd(element, () => {
                                state.depth--
                            })
                            state.depth++
                        } catch {
                            // No end tag, so nothing is nested in it
                        }
                        return
                    }
                    if (RAW_TEXT_ELEMENTS.has(element.tagName.toLowerCase()) || foreign.math > 0) {
                        return
                    }
                    try {
                        onEnd(element, () => {
                            state.phase = 'closed'
                            // Not a decrement: an inner container left open never runs its own callback
                            state.depth = 0
                        })
                    } catch {
                        // Self-closing foreign element (`<path/>`), so there is no end tag to close the cut at
                        unsupported = true
                        return
                    }
                    state.depth++
                    state.phase = fromMarker ? 'scanning' : 'open'
                    state.nested = false
                    state.foreign = foreign.svg > 0
                    // Closed by the container's own end, so what other components append lands outside it. Sentinels
                    // in the tags let `splice` find the container; pass 2 removes the tags with them.
                    element.prepend(fromMarker ? `<${tag} data-keep ${sentinel(index, 'o')}>` : cut, html)
                    element.append(fromMarker ? `</${tag} ${sentinel(index, 'c')}>` : close, html)
                    wrapped++
                },
            },
        })
        cleanups.push({
            selector: container,
            handler: {
                element() {
                    atContainer = 0
                },
            },
        })

        if (toMarker) {
            markers.push(
                {
                    selector: combineSelectors(container, ' > ', toMarker),
                    handler: {
                        element() {
                            state.directEnd = state.depth === 1
                        },
                    },
                },
                {
                    selector: combineSelectors(container, ' ', toMarker),
                    handler: {
                        element(element: RewriterElement) {
                            const direct = state.directEnd
                            state.directEnd = false
                            // Before the start marker, or inside it
                            if (state.phase !== 'open') {
                                return
                            }
                            if (!direct || atContainer) {
                                unsupported = true
                                return
                            }
                            element.before(state.nested ? comment(index, 'e') : close + keep, html)
                            state.phase = 'closed'
                        },
                    },
                },
            )
        }
        if (fromMarker) {
            markers.push(
                {
                    selector: combineSelectors(container, ' > ', fromMarker),
                    handler: {
                        element() {
                            state.directStart = state.depth === 1
                        },
                    },
                },
                {
                    selector: combineSelectors(container, ' ', fromMarker),
                    handler: {
                        element(element: RewriterElement) {
                            const direct = state.directStart
                            state.directStart = false
                            if (state.phase !== 'scanning') {
                                return
                            }
                            // Another range's wrapper tags would come apart in the splice
                            if (atContainer || (!direct && (ranges.length > 1 || state.foreign || foreign.math > 0))) {
                                unsupported = true
                                return
                            }
                            if (direct) {
                                element.after(close + cut, html)
                            } else {
                                // Later `after` content lands closer to the element
                                element.before(comment(index, 's'), html)
                                element.after(comment(index, 'r'), html)
                                for (const [content, options] of replacement.slice().reverse()) {
                                    element.after(content, options)
                                }
                                state.nested = true
                                nested++
                            }
                            state.phase = 'inStart'
                            if (!element.onEndTag || isVoidElement(element)) {
                                state.phase = 'open'
                                return
                            }
                            try {
                                onEnd(element, () => {
                                    state.phase = 'open'
                                })
                            } catch {
                                // Self-closing foreign element, so nothing is inside it
                                state.phase = 'open'
                            }
                        },
                    },
                },
            )
        }

        unwrap.push({
            selector: tag,
            handler: {
                element(element: RewriterElement) {
                    if (element.hasAttribute('data-keep')) {
                        element.removeAndKeepContent()
                        return
                    }
                    for (const [content, options] of replacement) {
                        element.before(content, options)
                    }
                    element.remove()
                },
            },
        })
    })

    return {
        componentKeys: ranges.map(({ componentKey }) => componentKey),
        // Every container handler, then every marker handler, so a marker sees whether it is also a container
        handlers: [...handlers, ...markers, ...cleanups],
        unwrap,
        wrapped: () => wrapped,
        unsupported: () => unsupported,
        fail: () => {
            unsupported = true
        },
        nested: () => nested,
        splice: async (page, rewriter, headers) => {
            // Only taken with one range, so every sentinel is that range's
            const needle = new TextEncoder().encode(sentinel(0, 'o').slice(0, -1))
            const { forward, backward } = finders(page, needle)
            const kindAt = (at: number) => String.fromCharCode(page[at + needle.length] ?? 0)
            const end = (at: number) => at + needle.length + 1
            const closeTag = `</mos-range-${nonce}-0 `.length
            if (wrapped === 1 && nested === 1) {
                // One container: find the start of the cut from the top and its end from the bottom, never reading the cut
                const o = forward(0)
                const s = o === -1 ? -1 : forward(o + 1)
                const r = s === -1 ? -1 : forward(s + 1)
                const c = backward(page.length - 1)
                if (kindAt(o) !== 'o' || kindAt(s) !== 's' || kindAt(r) !== 'r' || kindAt(c) !== 'c' || c < r) {
                    return null
                }
                const before = backward(c - 1)
                const resume = before === r ? c - closeTag : kindAt(before) === 'e' && before > r ? end(before) + COMMENT_CLOSE : -1
                const closers = resume === -1 ? null : await closingTags(rewriter, page.subarray(end(o) + 1, s - COMMENT_OPEN), headers)
                if (!closers) {
                    return null
                }
                return concat([
                    page.subarray(0, s - COMMENT_OPEN),
                    page.subarray(end(s) + COMMENT_CLOSE, r - COMMENT_OPEN),
                    closers,
                    page.subarray(resume),
                ])
            }
            const find = (from: number) => forward(from)
            const out: Uint8Array<ArrayBuffer>[] = []
            let copyFrom = 0
            let contentStart = -1
            let closers: Uint8Array<ArrayBuffer> | null = null
            let cutting = false
            let cuts = 0
            for (let at = find(0); at !== -1; at = find(at + 1)) {
                const kind = kindAt(at)
                const end = at + needle.length + 1
                if (cutting) {
                    if (kind === 'e') {
                        copyFrom = end + COMMENT_CLOSE
                    } else if (kind === 'c') {
                        copyFrom = at - closeTag
                    } else {
                        return null
                    }
                    cutting = false
                } else if (kind === 'o') {
                    contentStart = end + 1
                } else if (kind === 'c' && !closers) {
                    contentStart = -1
                } else if (kind === 's' && !closers && contentStart !== -1) {
                    closers = await closingTags(rewriter, page.subarray(contentStart, at - COMMENT_OPEN), headers)
                    if (!closers) {
                        return null
                    }
                    out.push(page.subarray(copyFrom, at - COMMENT_OPEN))
                    copyFrom = end + COMMENT_CLOSE
                } else if (kind === 'r' && closers) {
                    out.push(page.subarray(copyFrom, at - COMMENT_OPEN), closers)
                    closers = null
                    cutting = true
                    cuts++
                } else {
                    // A sentinel lost with what another component removed, or out of order
                    return null
                }
            }
            if (cutting || closers || cuts !== nested) {
                return null
            }
            out.push(page.subarray(copyFrom))
            return concat(out)
        },
    }
}

const concat = (chunks: Uint8Array<ArrayBuffer>[]) => {
    const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.length
    }
    return joined
}

/**
 * Finds `needle`, which starts with the rare `MARK` byte, from either end of a page. The native search for that byte
 * keeps the cost low and steady; a byte loop in JavaScript was as fast only while the engine kept it optimised.
 */
const finders = (page: Uint8Array, needle: Uint8Array) => {
    const matches = (at: number) => {
        for (let i = 1; i < needle.length; i++) {
            if (page[at + i] !== needle[i]) {
                return false
            }
        }
        return true
    }
    return {
        forward: (from: number) => {
            for (let at = page.indexOf(MARK, from); at !== -1; at = page.indexOf(MARK, at + 1)) {
                if (matches(at)) {
                    return at
                }
            }
            return -1
        },
        backward: (from: number) => {
            for (let at = from < 0 ? -1 : page.lastIndexOf(MARK, from); at !== -1; at = at === 0 ? -1 : page.lastIndexOf(MARK, at - 1)) {
                if (matches(at)) {
                    return at
                }
            }
            return -1
        },
    }
}

/** End tags for the elements still open at the end of `prefix`, innermost first; null if they can't be told. */
const closingTags = async (rewriter: HtmlRewriterAdapter, prefix: Uint8Array<ArrayBuffer>, headers: Headers) => {
    const open: { name: string }[] = []
    let failed = false
    const session = rewriter.create().on('*', {
        element(element: RewriterElement) {
            if (isVoidElement(element)) {
                return
            }
            if (!element.onEndTag) {
                failed = true
                return
            }
            const entry = { name: element.tagName }
            try {
                // An end tag also closes the elements left open inside it
                element.onEndTag(() => {
                    const index = open.lastIndexOf(entry)
                    if (index !== -1) {
                        open.length = index
                    }
                })
                open.push(entry)
            } catch {
                // Self-closing, so never open
            }
        },
    })
    await session.transform(new Response(prefix, { headers })).arrayBuffer()
    const names = open.map(({ name }) => name).reverse()
    // Written as ASCII, whatever the page's encoding
    if (failed || !names.every((name) => /^[\x21-\x7e]+$/.test(name))) {
        return null
    }
    return new TextEncoder().encode(names.map((name) => `</${name}>`).join(''))
}
