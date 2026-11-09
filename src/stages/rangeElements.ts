import type { ElementHandlers, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import { combineSelectors } from './selectors'
import { isVoidElement } from './voidElements'

export type RangeVisitor = {
    /** A container is open, so the element is in it */
    open: () => boolean
    child: (element: RewriterElement) => void
}

export type RangeElements = {
    /** Registered ahead of the range handlers, on every container and everything in one. */
    handler: { selector: string; handler: ElementHandlers }
    onEnd: EndTags['onEnd']
}

export type EndTags = {
    /** Runs first for every element the other handlers call `onEnd` on. */
    start: () => void
    /** Runs `callback` at the element's end tag; false when it has none. */
    onEnd: (element: RewriterElement, callback: () => void) => boolean
}

/** Only the last end tag callback registered on an element runs, so the range handlers on an element share one. */
export const createEndTags = (): EndTags => {
    let current: (() => void)[] | null = null
    let started = false
    return {
        start() {
            current = null
            started = false
        },
        onEnd(element, callback) {
            if (started) {
                current?.push(callback)
                return current !== null
            }
            started = true
            if (!element.onEndTag || isVoidElement(element)) {
                return false
            }
            const callbacks = [callback]
            try {
                element.onEndTag(() => {
                    for (const run of callbacks) {
                        run()
                    }
                })
            } catch {
                // Self-closing, so no end tag
                return false
            }
            current = callbacks
            return true
        },
    }
}

/**
 * One handler on every container and descendant starts each element and visits it for the components whose
 * container it is in, in place of a `${container} *` handler per component, so they share its end tag.
 */
export const createRangeElements = (containers: string[], visitors: RangeVisitor[]): RangeElements => {
    const endTags = createEndTags()
    return {
        handler: {
            selector: containers.flatMap((container) => [container, combineSelectors(container, ' ', '*')]).join(', '),
            handler: {
                element(element: RewriterElement) {
                    endTags.start()
                    for (const visitor of visitors) {
                        if (visitor.open()) {
                            visitor.child(element)
                        }
                    }
                },
            },
        },
        onEnd: endTags.onEnd,
    }
}
