import type { ElementHandlers, HtmlRewriterAdapter, RewriterElement } from '../../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../../context'
import type { SurfaceDecisionResponse } from '../../types'
import { combineSelectors } from '../selectors'
import { createRangeElements, type RangeElements, type RangeVisitor } from './rangeElements'
import { createContainerStack } from './rangeTracker'

export type SurfaceMarkers = {
    componentsWithInvalidSelectors: string[]
    markers: Record<string, ComponentRange[]>
}

export type ComponentRange = {
    /** By element number; an element in an inner container is in that container's range instead */
    markers: Marker[]
    /** Element numbers of its end markers and inner containers, in order. The cut keeps them and what holds them. */
    kept: number[]
}

export type Marker = {
    endTag: number | null
    startMarker: boolean
    endMarker: boolean
}

type Handler = { selector: string; handler: ElementHandlers }
type ComponentHandlers = { componentKey: string; container: string; visitor: RangeVisitor; handlers: Handler[] }

/**
 * For any modifications with start or end markers, find the positions of those markers.
 * Runs a single pass of the rewriter over a cloned response to build per-component marker maps.
 */
export const findMarkerPositions = async (
    ctx: HtmlStageContext,
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
): Promise<SurfaceMarkers> => {
    const markers: SurfaceMarkers['markers'] = Object.fromEntries(
        Object.entries(surfaceDecisions.componentBehaviors).map(([key]) => [key, []]),
    )

    let elements: RangeElements | null = null
    const components: ComponentHandlers[] = Object.entries(surfaceDecisions.componentBehaviors).flatMap<ComponentHandlers>(
        ([componentKey, componentBehavior]) => {
            const modification = componentBehavior.content?.replaceRange
            if (!componentBehavior.metadata?.cssSelector || !modification) {
                return []
            }
            const { toMarker, fromMarker } = modification
            const container = componentBehavior.metadata.cssSelector
            const stack = createContainerStack<ComponentRange>((element, callback) => elements?.onEnd(element, callback) ?? false)
            // The current element and the range it is in
            let current: { range: ComponentRange; marker: Marker } | null = null
            // The marker handlers run after the shared handler has visited the element
            const onMarker = (mark: (current: { range: ComponentRange; marker: Marker }) => void) => () => {
                if (current) {
                    mark(current)
                }
            }

            const handlers: Handler[] = [
                {
                    selector: container,
                    handler: {
                        element: (element: RewriterElement) => {
                            const range: ComponentRange = { markers: [], kept: [] }
                            markers[componentKey]?.push(range)
                            const outer = stack.top()
                            if (stack.enter(element, range)) {
                                // An inner container, which the outer one cuts around
                                outer?.kept.push(stack.count())
                            }
                        },
                    },
                },
            ]
            if (toMarker) {
                handlers.push({
                    selector: combineSelectors(container, ' ', toMarker),
                    handler: {
                        element: onMarker(({ range, marker }) => {
                            marker.endMarker = true
                            range.kept.push(stack.count())
                        }),
                    },
                })
            }
            if (fromMarker) {
                handlers.push({
                    selector: combineSelectors(container, ' ', fromMarker),
                    handler: {
                        element: onMarker(({ marker }) => {
                            marker.startMarker = true
                        }),
                    },
                })
            }
            const visitor = stack.visitor((element, number, range) => {
                const marker: Marker = { endMarker: false, startMarker: false, endTag: null }
                range.markers[number] = marker
                current = { range, marker }
                // Unnamed, as bundlers that keep function names would name it on every element
                if (
                    !elements?.onEnd(element, () => {
                        marker.endTag = stack.count()
                    })
                ) {
                    marker.endTag = number
                }
            })
            return [{ componentKey, container, visitor, handlers }]
        },
    )

    if (!components.length || !response.body) {
        return { markers, componentsWithInvalidSelectors: [] }
    }

    const componentsWithInvalidSelectors: string[] = []
    const logFailure = (selector: string, componentKey: string, error: unknown) => {
        ctx.logger.log({
            level: 'error',
            code: 'marker-pass-selector-failed',
            message: 'Failed to register marker-pass handler for component selector; skipping range replacement for this component.',
            context: { selector, componentKey },
            error,
        })
        componentsWithInvalidSelectors.push(componentKey)
    }
    const register = (included: ComponentHandlers[]) => {
        elements = createRangeElements(
            included.map(({ container }) => container),
            included.map(({ visitor }) => visitor),
        )
        let session = rewriter.create().on(elements.handler.selector, elements.handler.handler)
        for (const { handlers } of included) {
            for (const { selector, handler } of handlers) {
                session = session.on(selector, handler)
            }
        }
        return session
    }
    // A component whose handlers don't all register is dropped, so the shared handler only covers valid containers.
    // `${container} *` is part of the shared handler's selector, so it is checked here too.
    const isValid = ({ componentKey, container, handlers }: ComponentHandlers) => {
        let probe = rewriter.create()
        for (const selector of [container, combineSelectors(container, ' ', '*'), ...handlers.map((h) => h.selector)]) {
            try {
                probe = probe.on(selector, {})
            } catch (error) {
                logFailure(selector, componentKey, error)
                return false
            }
        }
        return true
    }

    let session: ReturnType<typeof register>
    try {
        session = register(components)
    } catch {
        const valid = components.filter(isValid)
        if (!valid.length) {
            return { markers, componentsWithInvalidSelectors }
        }
        session = register(valid)
    }

    const copy = response.clone()
    try {
        await session.transform(copy).text()
    } catch (error) {
        // An unread copy would keep the origin open; a no-op if the rewriter took it
        copy.body?.cancel().catch(() => {})
        throw error
    }
    return { markers, componentsWithInvalidSelectors }
}
