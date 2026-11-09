import type { ElementHandlers, RewriterElement, RewriterText } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { SubSurfaceBehaviorApi } from '../types'
import { renderElement } from './elements'
import type { ComponentRange } from './findMarkerPositions'
import type { RangeElements, RangeVisitor } from './rangeElements'
import { type Cut, createContainerStack, endCut, firstPhase, startCut } from './rangeTracker'
import { isVoidElement } from './voidElements'

export type ReplacementHandler = { selector: string; handler: ElementHandlers }

export type ReplacementHandlers = {
    container: ReplacementHandler
    /** Visits each element in a container, from the shared handler */
    visitor: RangeVisitor
}

/**
 * Requires a prior pass by `findMarkerPositions` to populate `ranges`. Depends on `element.onEndTag` to detect element
 * boundaries, so the caller skips this step on adapters without `capabilities.onEndTag`. The `visitor` runs from a
 * `createRangeElements` handler, which also provides `onEnd`.
 */
export const buildReplacementHandlers = (
    ctx: HtmlStageContext,
    subSurface: SubSurfaceBehaviorApi,
    ranges: ComponentRange[] | undefined,
    onEnd: RangeElements['onEnd'],
): ReplacementHandlers | null => {
    const { logger } = ctx
    const modification = subSurface.content?.replaceRange
    const selector = subSurface.metadata.cssSelector
    if (!modification || !ranges || !selector) {
        return null
    }

    if (modification.fromMarker && modification.toMarker && modification.fromMarker === modification.toMarker) {
        logger.log({
            level: 'warn',
            code: 'replacement-markers-identical',
            message: 'Range replacement skipped: fromMarker and toMarker are identical.',
            context: { marker: modification.fromMarker, selector },
        })
        return null
    }

    // A removed container still opens a range, so the ranges line up with the marker pass, but cuts nothing
    type Frame = Cut & { range: ComponentRange | undefined }
    const stack = createContainerStack<Frame>(onEnd)
    let rangeIndex = -1
    const insert = (place: (content: string, options?: { html?: boolean }) => void) => {
        for (const item of (modification.replaceWith ?? []).slice().reverse()) {
            place(...renderElement(ctx, item))
        }
    }

    const visitor = stack.visitor((element, number, frame) => {
        const { range } = frame
        const marker = range?.markers[number]
        if (frame.phase === 'scanning') {
            if (marker?.startMarker && startCut(frame, element, onEnd)) {
                insert((content, options) => element.after(content, options))
            }
            return
        }
        // A marker another component removed still marks the cut
        if (frame.phase !== 'open' || (marker?.endMarker && endCut(frame)) || element.removed) {
            return
        }
        // An end marker, an inner container (cut by its own range) or an element holding one is kept
        if (range && marker?.endTag && holdsAny(range.kept, number, marker.endTag)) {
            return
        }
        element.remove()
    })

    const parentHandler: ElementHandlers = {
        element(element: RewriterElement) {
            const range = ranges[++rangeIndex]
            // No content to cut
            if (isVoidElement(element)) {
                return
            }
            const frame: Frame = { phase: element.removed ? 'closed' : firstPhase(modification.fromMarker), range }
            if (frame.phase === 'open') {
                insert((content, options) => element.prepend(content, options))
            }
            stack.enter(element, frame)
        },

        text: (text: RewriterText) => {
            if (stack.top()?.phase === 'open') {
                text.remove()
            }
        },
    }

    return { container: { selector, handler: parentHandler }, visitor }
}

/** Whether a sorted list has a number from `from` to `to`: element `from`, whose last element is `to`, is or holds it. */
const holdsAny = (sorted: number[], from: number, to: number) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
        const mid = (low + high) >> 1
        if ((sorted[mid] as number) < from) {
            low = mid + 1
        } else {
            high = mid
        }
    }
    return low < sorted.length && (sorted[low] as number) <= to
}
