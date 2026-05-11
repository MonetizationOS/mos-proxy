import type { ElementHandlers, RewriterElement, RewriterText } from '../adapters/HtmlRewriterAdapter'
import type { PipelineContext } from '../context'
import type { SubSurfaceBehaviorApi } from '../types'
import { renderElement } from './elements'
import type { ComponentRange } from './findMarkerPositions'

type ReplacementState = {
    operation: 'SCANNING' | 'REMOVING' | 'REPLACED'
}

export type ReplacementHandler = { selector: string; handler: ElementHandlers }

/**
 * Requires a prior pass by `findMarkerPositions` to populate `ranges`. Depends on
 * `element.onEndTag` to detect element boundaries — on adapters without `capabilities.onEndTag`,
 * the caller should skip this step.
 */
export const buildReplacementHandlers = (
    ctx: PipelineContext,
    subSurface: SubSurfaceBehaviorApi,
    ranges: ComponentRange[] | undefined,
): ReplacementHandler[] => {
    const { logger } = ctx
    const modification = subSurface.content?.replaceRange
    if (!modification || !ranges) {
        return []
    }

    if (modification.fromMarker && modification.toMarker && modification.fromMarker === modification.toMarker) {
        logger.log({
            level: 'warn',
            code: 'replacement-markers-identical',
            message: 'Range replacement skipped: fromMarker and toMarker are identical.',
            context: { marker: modification.fromMarker, selector: subSurface.metadata.cssSelector },
        })
        return []
    }

    let elementCounter = 0
    let rangeIndex = -1
    const states: ReplacementState[] = []
    const getCurrentState = () => {
        const state = states[states.length - 1]
        if (!state) {
            logger.log({
                level: 'warn',
                code: 'replacement-state-missing',
                message: 'Range replacement handler invoked with no active replacement state; skipping.',
                context: { selector: subSurface.metadata.cssSelector },
            })
            return
        }
        return state
    }

    const onChildElement = (element: RewriterElement) => {
        elementCounter++
        if (element.removed) {
            return
        }

        const state = getCurrentState()
        const range = ranges[rangeIndex]
        const marker = range?.markers[elementCounter]

        if (state?.operation === 'SCANNING') {
            if (marker?.startMarker) {
                for (const after of (modification.replaceWith ?? []).slice().reverse()) {
                    const [content, options] = renderElement(ctx, after)
                    element.after(content, options)
                }
                if (element.onEndTag) {
                    try {
                        element.onEndTag(() => {
                            state.operation = 'REMOVING'
                        })
                    } catch {
                        state.operation = 'REMOVING'
                    }
                } else {
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

            element.remove()
            return
        }
    }

    const parentHandler: ElementHandlers = {
        element(element: RewriterElement) {
            rangeIndex++
            if (element.removed) {
                return
            }

            const state: ReplacementState = { operation: modification.fromMarker ? 'SCANNING' : 'REMOVING' }
            states.push(state)

            if (state.operation === 'REMOVING') {
                for (const prepend of (modification.replaceWith ?? []).slice().reverse()) {
                    const [content, options] = renderElement(ctx, prepend)
                    element.prepend(content, options)
                }
            }

            if (element.onEndTag) {
                element.onEndTag(() => {
                    states.pop()
                })
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
        return []
    }
    return [
        { selector, handler: parentHandler },
        { selector: `${selector} *`, handler: { element: onChildElement } },
    ]
}
