import type { ElementHandlers, RewriterElement } from '../adapters/HtmlRewriterAdapter'
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
export const combineSelectors = (container: string, combinator: ' ' | ' > ', inner: string) =>
    splitSelectorList(container)
        .flatMap((outer) => splitSelectorList(inner).map((part) => `${outer}${combinator}${part}`))
        .join(', ')

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
}

type RangeState = {
    depth: number
    // `inStart`: a start marker nested in the first one doesn't start the range again
    phase: 'scanning' | 'inStart' | 'open' | 'closed'
    // Set by a `>` handler for the check on the same element, which runs after it
    directStart: boolean
    directEnd: boolean
}

/**
 * Cuts each range by splitting its container into wrapper elements in one pass and removing the one that holds the
 * range in the next, so the cut costs one callback instead of one per element. The split only balances when both
 * markers are direct children of the outermost container; a nested marker makes the page unsupported. What other
 * components insert inside the cut is removed with it, and a marker removed by another component still marks the cut.
 * A container holding raw text, or inside `math`, is left alone.
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
    // Ranges whose container handler has run for the current element, cleared once its marker handlers have run
    let atContainer = 0
    // The rewriter mismatches the wrapper's end tags inside MathML
    let mathDepth = 0

    // Only the last end tag callback registered on an element runs, so one registered on `math` keeps its count
    const onEnd = (element: RewriterElement, callback: () => void) => {
        const math = element.tagName.toLowerCase() === 'math'
        element.onEndTag?.(
            math
                ? () => {
                      mathDepth--
                      callback()
                  }
                : callback,
        )
    }

    const handlers: Handler[] = [
        {
            selector: 'math',
            handler: {
                element(element: RewriterElement) {
                    mathDepth++
                    try {
                        element.onEndTag?.(() => {
                            mathDepth--
                        })
                    } catch {
                        mathDepth--
                    }
                },
            },
        },
    ]
    const markers: Handler[] = []
    const cleanups: Handler[] = []
    const unwrap: Handler[] = []

    ranges.forEach(({ replaceRange, container }, index) => {
        const { fromMarker, toMarker } = replaceRange
        const tag = `mos-range-${nonce}-${index}`
        const cut = `<${tag}>`
        const keep = `<${tag} data-keep>`
        const close = `</${tag}>`
        const state: RangeState = { depth: 0, phase: 'closed', directStart: false, directEnd: false }

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
                    if (RAW_TEXT_ELEMENTS.has(element.tagName.toLowerCase()) || mathDepth > 0) {
                        return
                    }
                    try {
                        onEnd(element, () => {
                            state.phase = 'closed'
                            state.depth--
                        })
                    } catch {
                        unsupported = true
                        return
                    }
                    state.depth++
                    state.phase = fromMarker ? 'scanning' : 'open'
                    // Closed by the container's own end, so what other components append lands outside it
                    element.prepend(fromMarker ? keep : cut, html)
                    element.append(close, html)
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
                            element.before(close + keep, html)
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
                            if (!direct || atContainer) {
                                unsupported = true
                                return
                            }
                            element.after(close + cut, html)
                            state.phase = 'inStart'
                            try {
                                if (!element.onEndTag || isVoidElement(element)) {
                                    state.phase = 'open'
                                } else {
                                    onEnd(element, () => {
                                        state.phase = 'open'
                                    })
                                }
                            } catch {
                                state.phase = 'open'
                            }
                        },
                    },
                },
            )
        }

        const replacement = (replaceRange.replaceWith ?? []).map((item) => renderElement(ctx, item))
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
    }
}
