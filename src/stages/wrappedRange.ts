import type { ElementHandlers, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { SubSurfaceBehaviorApi, SurfaceDecisionResponse } from '../types'
import { renderElement } from './elements'
import { isVoidElement } from './voidElements'

type Handler = { selector: string; handler: ElementHandlers }

// Their content is text, so a wrapper tag inserted into it is never parsed as a tag
const RAW_TEXT_ELEMENTS = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'style', 'textarea', 'title', 'xmp'])

const INSERTIONS = ['prepend', 'append', 'before', 'after'] as const

const withoutNested = (selector: string) => selector.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]|\([^)]*\)/g, '')
// One compound selector, so `${container} > ${marker}` only matches a direct child
const isCompound = (selector: string) => !/[\s>+~,]/.test(withoutNested(selector.trim()))

export type RangeWrapper = {
    componentKey: string
    /** Pass 1, ahead of every other component: split each container into `<tag>` segments. */
    handlers: Handler[]
    /** Pass 1, in the range component's own place, so they see markers removed by the components before it. */
    checks: Handler[]
    /** Pass 2: drop the segment holding the range and put the replacement there; unwrap the rest. */
    unwrap: Handler
    wrapped: () => number
    /** Pass 1 met a page the wrapper can't cut the way the element path would, so the caller must redo it that way. */
    unsupported: () => boolean
    fail: () => void
}

/**
 * Cuts a range by splitting its container into wrapper elements in one pass and removing the one that holds the range
 * in the next, so the cut costs one callback instead of one per element. The split only balances when both markers
 * are direct children of the container. Only a decision with exactly one range component, and no other content on
 * that component, qualifies.
 */
export const planRangeWrapper = (ctx: HtmlStageContext, decisions: SurfaceDecisionResponse): RangeWrapper | null => {
    const ranges = Object.entries(decisions.componentBehaviors).filter(([, b]) => b.content?.replaceRange && b.metadata.cssSelector)
    if (ranges.length !== 1) {
        return null
    }
    const [componentKey, behavior] = ranges[0] as [string, SubSurfaceBehaviorApi]
    const { replaceRange, ...others } = behavior.content ?? {}
    if (!replaceRange || Object.values(others).some((value) => (Array.isArray(value) ? value.length : value))) {
        return null
    }
    const { fromMarker, toMarker } = replaceRange
    if (fromMarker && toMarker && fromMarker === toMarker) {
        return null
    }
    const container = behavior.metadata.cssSelector as string
    if ((fromMarker && !isCompound(fromMarker)) || (toMarker && !isCompound(toMarker)) || withoutNested(container).includes(',')) {
        return null
    }
    // Components ahead of the range whose inserts the element path places differently, or keeps where the wrapper cuts
    const keys = Object.keys(decisions.componentBehaviors)
    const inserting = keys
        .slice(0, keys.indexOf(componentKey))
        .map((key) => decisions.componentBehaviors[key])
        .filter((b) => b?.metadata.cssSelector && INSERTIONS.some((key) => b.content?.[key]?.length))
        .map((b) => b?.metadata.cssSelector as string)

    const tag = `mos-range-${Math.random().toString(36).slice(2, 10)}`
    const cut = `<${tag}>`
    const keep = `<${tag} data-keep>`
    const close = `</${tag}>`
    const html = { html: true }
    const replacement = (replaceRange.replaceWith ?? []).map((item) => renderElement(ctx, item))

    let unsupported = false
    let wrapped = 0
    let depth = 0
    // `inStart`: a start marker nested in the first one doesn't start the range again
    let phase: 'scanning' | 'inStart' | 'open' | 'closed' = 'closed'
    // Set by a `>` handler for the check on the same element, which runs after it
    let directStart = false
    let directEnd = false
    // Cleared by the range's own check on the container, after the components ahead of it
    let atContainer = false
    // The rewriter mismatches the wrapper's end tags inside MathML
    let mathDepth = 0

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
                        // Self-closing `<math/>`, so nothing is inside it
                        mathDepth--
                    }
                },
            },
        },
        {
            selector: container,
            handler: {
                element(element: RewriterElement) {
                    if (isVoidElement(element)) {
                        return
                    }
                    if (!element.onEndTag || RAW_TEXT_ELEMENTS.has(element.tagName.toLowerCase()) || mathDepth > 0 || depth > 0) {
                        unsupported = true
                        return
                    }
                    atContainer = true
                    depth++
                    phase = fromMarker ? 'scanning' : 'open'
                    // Closed by the container's own end, so what other components append lands outside it
                    element.prepend(fromMarker ? keep : cut, html)
                    element.append(close, html)
                    wrapped++
                    try {
                        element.onEndTag(() => {
                            phase = 'closed'
                            depth--
                        })
                    } catch {
                        // Self-closing foreign element (`<path/>`), so there is no end tag to close the cut at
                        unsupported = true
                    }
                },
            },
        },
    ]
    const checks: Handler[] = [
        {
            selector: container,
            handler: {
                element() {
                    atContainer = false
                },
            },
        },
    ]

    if (toMarker) {
        handlers.push({
            selector: `${container} > ${toMarker}`,
            handler: {
                element(element: RewriterElement) {
                    if (phase === 'open') {
                        element.before(close + keep, html)
                        phase = 'closed'
                        directEnd = true
                    }
                },
            },
        })
        checks.push({
            selector: `${container} ${toMarker}`,
            handler: {
                element(element: RewriterElement) {
                    if (directEnd) {
                        directEnd = false
                        unsupported ||= element.removed
                    } else if (phase === 'open') {
                        unsupported = true
                    }
                },
            },
        })
    }
    if (fromMarker) {
        handlers.push({
            selector: `${container} > ${fromMarker}`,
            handler: {
                element(element: RewriterElement) {
                    if (phase !== 'scanning') {
                        return
                    }
                    element.after(close + cut, html)
                    directStart = true
                    phase = 'inStart'
                    if (!element.onEndTag || isVoidElement(element)) {
                        phase = 'open'
                        return
                    }
                    try {
                        element.onEndTag(() => {
                            phase = 'open'
                        })
                    } catch {
                        // Self-closing foreign element, so nothing is inside it
                        phase = 'open'
                    }
                },
            },
        })
        checks.push({
            selector: `${container} ${fromMarker}`,
            handler: {
                element(element: RewriterElement) {
                    if (directStart) {
                        directStart = false
                        unsupported ||= element.removed
                    } else if (phase === 'scanning') {
                        unsupported = true
                    }
                },
            },
        })
    }

    // After the wrapper's own handlers, so they see its state for the same element
    for (const selector of inserting) {
        handlers.push({
            selector,
            handler: {
                element() {
                    if (atContainer || phase === 'open' || (phase === 'inStart' && directStart)) {
                        unsupported = true
                    }
                },
            },
        })
    }

    return {
        componentKey,
        handlers,
        checks,
        unwrap: {
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
        },
        wrapped: () => wrapped,
        unsupported: () => unsupported,
        fail: () => {
            unsupported = true
        },
    }
}
