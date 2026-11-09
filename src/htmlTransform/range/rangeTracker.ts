import type { RewriterElement } from '../../adapters/HtmlRewriterAdapter'
import type { EndTags, RangeVisitor } from './rangeElements'

/**
 * Where a container's cut is: before its start marker, inside it, cutting, or past the end marker. A start marker
 * nested in the first one doesn't start the cut again, and only the first end marker after the start ends it.
 */
export type Phase = 'scanning' | 'inStart' | 'open' | 'closed'

export type Cut = { phase: Phase }

export const firstPhase = (fromMarker: string | undefined): Phase => (fromMarker ? 'scanning' : 'open')

/** Starts the cut at a start marker, unless it already started. It opens at the marker's end. */
export const startCut = (cut: Cut, element: RewriterElement, onEnd: EndTags['onEnd']) => {
    if (cut.phase !== 'scanning') {
        return false
    }
    cut.phase = 'inStart'
    const open = () => {
        cut.phase = 'open'
    }
    if (!onEnd(element, open)) {
        open()
    }
    return true
}

/** Ends the cut at an end marker, if it is cutting. */
export const endCut = (cut: Cut) => {
    if (cut.phase !== 'open') {
        return false
    }
    cut.phase = 'closed'
    return true
}

/**
 * The open containers of one range component, innermost last, and the number of each element in them. Both range
 * passes keep one, so they number the same elements and give each to the innermost container's range.
 */
export const createContainerStack = <Frame>(onEnd: EndTags['onEnd']) => {
    const open: Frame[] = []
    let count = 0
    return {
        top: () => open.at(-1),
        count: () => count,
        /** False when the container has no end tag, so a container it is in cuts it as any element. */
        enter(element: RewriterElement, frame: Frame) {
            const index = open.length
            // Its end also closes containers left open in it
            if (
                !onEnd(element, () => {
                    open.length = index
                })
            ) {
                return false
            }
            open.push(frame)
            return true
        },
        visitor: (child: (element: RewriterElement, number: number, frame: Frame) => void): RangeVisitor => ({
            open: () => open.length > 0,
            child: (element) => child(element, ++count, open.at(-1) as Frame),
        }),
    }
}
