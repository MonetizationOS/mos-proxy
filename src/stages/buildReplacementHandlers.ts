import type { ElementHandlers, RewriterElement, RewriterText } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { SubSurfaceBehaviorApi } from '../types'
import { renderElement } from './elements'
import type { ComponentRange } from './findMarkerPositions'
import type { RangeElements, RangeVisitor } from './rangeElements'
import { isVoidElement } from './voidElements'

type ReplacementState = {
    // `IN_START`: a start marker nested in the first one doesn't start the range again
    operation: 'SCANNING' | 'IN_START' | 'REMOVING' | 'REPLACED'
}

export type ReplacementHandler = { selector: string; handler: ElementHandlers }

export type ReplacementHandlers = {
    container: ReplacementHandler
    /** Visits each element in a container, from the shared handler */
    visitor: RangeVisitor
}

/**
 * Requires a prior pass by `findMarkerPositions` to populate `ranges`. Depends on
 * `element.onEndTag` to detect element boundaries — on adapters without `capabilities.onEndTag`,
 * the caller should skip this step. The `visitor` runs from a `createRangeElements` handler,
 * which also provides `onEnd`.
 */
export const buildReplacementHandlers = (
    ctx: HtmlStageContext,
    subSurface: SubSurfaceBehaviorApi,
    ranges: ComponentRange[] | undefined,
    onEnd: RangeElements['onEnd'],
): ReplacementHandlers | null => {
    const { logger } = ctx
    const modification = subSurface.content?.replaceRange
    if (!modification || !ranges) {
        return null
    }

    if (modification.fromMarker && modification.toMarker && modification.fromMarker === modification.toMarker) {
        logger.log({
            level: 'warn',
            code: 'replacement-markers-identical',
            message: 'Range replacement skipped: fromMarker and toMarker are identical.',
            context: { marker: modification.fromMarker, selector: subSurface.metadata.cssSelector },
        })
        return null
    }

    let elementCounter = 0
    let rangeIndex = -1
    // Open containers, innermost last; each element is in the range of the innermost one. A removed container has no state.
    const open: { state: ReplacementState | null; range: ComponentRange | undefined }[] = []
    const getCurrentState = () => {
        const frame = open.at(-1)
        if (!frame) {
            logger.log({
                level: 'warn',
                code: 'replacement-state-missing',
                message: 'Range replacement handler invoked with no active replacement state; skipping.',
                context: { selector: subSurface.metadata.cssSelector },
            })
            return
        }
        return frame.state ?? undefined
    }

    const onChildElement = (element: RewriterElement) => {
        elementCounter++
        if (element.removed) {
            return
        }

        const state = getCurrentState()
        const range = open.at(-1)?.range
        const marker = range?.markers[elementCounter]

        if (state?.operation === 'SCANNING') {
            if (marker?.startMarker) {
                for (const after of (modification.replaceWith ?? []).slice().reverse()) {
                    const [content, options] = renderElement(ctx, after)
                    element.after(content, options)
                }
                state.operation = 'IN_START'
                if (
                    !onEnd(element, () => {
                        state.operation = 'REMOVING'
                    })
                ) {
                    state.operation = 'REMOVING'
                }
            }
            return
        }

        if (state?.operation === 'REMOVING') {
            if (marker?.endMarker) {
                state.operation = 'REPLACED'
                return
            }

            if (marker?.endTag !== elementCounter && marker?.nextEndMarker && marker?.endTag && marker.endTag >= marker.nextEndMarker) {
                return
            }

            // A nested container, or an element holding one, is kept for the nested container's own range
            if (range && marker?.endTag && holdsIsland(range.islands, elementCounter, marker.endTag)) {
                return
            }

            element.remove()
            return
        }
    }

    const parentHandler: ElementHandlers = {
        element(element: RewriterElement) {
            rangeIndex++
            // No content to cut
            if (isVoidElement(element)) {
                return
            }
            // A removed container still opens a range, so the ranges line up with the marker pass
            const state: ReplacementState | null = element.removed ? null : { operation: modification.fromMarker ? 'SCANNING' : 'REMOVING' }

            if (state?.operation === 'REMOVING') {
                for (const prepend of (modification.replaceWith ?? []).slice().reverse()) {
                    const [content, options] = renderElement(ctx, prepend)
                    element.prepend(content, options)
                }
            }
            const index = open.length
            // A self-closing foreign container (`<path/>`) has no end tag or content to cut. A container's end also
            // closes containers left open in it.
            if (
                onEnd(element, () => {
                    open.length = index
                })
            ) {
                open.push({ state, range: ranges[rangeIndex] })
            }
        },

        text: (text: RewriterText) => {
            const state = getCurrentState()
            if (state?.operation === 'REMOVING') {
                text.remove()
            }
        },
    }

    const selector = subSurface.metadata.cssSelector
    if (!selector) {
        return null
    }
    return { container: { selector, handler: parentHandler }, visitor: { open: () => open.length > 0, child: onChildElement } }
}

/** Whether element `from` is a nested container or holds one: one starts from it to `to`, its last element. */
const holdsIsland = (islands: number[], from: number, to: number) => {
    let low = 0
    let high = islands.length
    while (low < high) {
        const mid = (low + high) >> 1
        if ((islands[mid] as number) < from) {
            low = mid + 1
        } else {
            high = mid
        }
    }
    return low < islands.length && (islands[low] as number) <= to
}
