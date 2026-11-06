import type { ElementHandlers, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import { isVoidElement } from './voidElements'
import { combineSelectors } from './wrappedRange'

export type RangeVisitor = {
    /** A container is open, so the element is in it */
    open: () => boolean
    child: (element: RewriterElement) => void
}

export type RangeElements = {
    /** Registered ahead of the range handlers, on every container and everything in one. */
    handler: { selector: string; handler: ElementHandlers }
    /** Runs `callback` at the element's end tag; false when it has none. */
    onEnd: (element: RewriterElement, callback: () => void) => boolean
}

/**
 * Only the last end tag callback registered on an element runs, so range handlers from several components
 * share one per element. One handler on every container and descendant starts each element and visits it for
 * the components whose container it is in, in place of a `${container} *` handler per component.
 */
export const createRangeElements = (containers: string[], visitors: RangeVisitor[]): RangeElements => {
    let current: (() => void)[] | null = null
    let started = false
    return {
        handler: {
            selector: containers.flatMap((container) => [container, combineSelectors(container, ' ', '*')]).join(', '),
            handler: {
                element(element: RewriterElement) {
                    current = null
                    started = false
                    for (const visitor of visitors) {
                        if (visitor.open()) {
                            visitor.child(element)
                        }
                    }
                },
            },
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
