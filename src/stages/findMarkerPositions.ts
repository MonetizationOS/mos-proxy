import type { ElementHandlers, HtmlRewriterAdapter, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import { createRangeElements, type RangeElements, type RangeVisitor } from './rangeElements'
import { combineSelectors } from './wrappedRange'

export type SurfaceMarkers = {
    componentsWithInvalidSelectors: string[]
    markers: Record<string, ComponentRange[]>
}

export type ComponentRange = {
    /** By element number; an element in a nested container is in that container's range instead */
    markers: Marker[]
    /** The element number before the container's first element */
    start: number
    /** Element numbers of the containers nested in this one, in order. The range cuts around them. */
    islands: number[]
}

export type Marker = {
    endTag: number | null
    startMarker: boolean
    endMarker: boolean
    nextEndMarker: number | null
}

type Handler = { selector: string; componentKey: string; handler: ElementHandlers }
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
    const logInvalidState = (location: string, componentKey: string) => {
        ctx.logger.log({
            level: 'warn',
            code: 'marker-pass-invalid-state',
            message: 'Marker handler invoked with no active range; skipping.',
            context: { location, componentKey },
        })
    }

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
            let elementCounter = 0
            // Open containers, innermost last. Each element is in the range of the innermost one.
            const open: ComponentRange[] = []
            // The current element and the range it is in
            let current: { range: ComponentRange; marker: Marker } | null = null

            const entries: (Handler | null)[] = [
                {
                    selector: `${componentBehavior.metadata.cssSelector}`,
                    componentKey,
                    handler: {
                        element: (element: RewriterElement) => {
                            const range: ComponentRange = { markers: [], start: elementCounter, islands: [] }
                            markers[componentKey]?.push(range)
                            const index = open.length
                            // With no end tag there is nothing to cut in it, so a container it is in cuts it as any element.
                            // Its end also closes containers left open in it.
                            if (
                                elements?.onEnd(element, () => {
                                    open.length = index
                                })
                            ) {
                                // Nested in another container, which cuts around it
                                open.at(-1)?.islands.push(elementCounter)
                                open.push(range)
                            }
                        },
                    },
                },
                toMarker
                    ? {
                          selector: combineSelectors(componentBehavior.metadata.cssSelector, ' ', toMarker),
                          componentKey,
                          handler: {
                              element() {
                                  if (!current) {
                                      logInvalidState('to-marker', componentKey)
                                      return
                                  }
                                  const { range, marker } = current
                                  marker.endMarker = true
                                  for (let i = elementCounter; i > range.start; i--) {
                                      // Missing where the element is in a nested container's range
                                      const m = range.markers[i]
                                      if (m?.nextEndMarker) {
                                          break
                                      }
                                      if (m) {
                                          m.nextEndMarker = elementCounter
                                      }
                                  }
                              },
                          },
                      }
                    : null,
                fromMarker
                    ? {
                          selector: combineSelectors(componentBehavior.metadata.cssSelector, ' ', fromMarker),
                          componentKey,
                          handler: {
                              element() {
                                  if (!current) {
                                      logInvalidState('from-marker', componentKey)
                                      return
                                  }
                                  current.marker.startMarker = true
                              },
                          },
                      }
                    : null,
            ]
            const visitor: RangeVisitor = {
                open: () => open.length > 0,
                child(element: RewriterElement) {
                    const currentRange = open.at(-1)
                    if (!currentRange) {
                        logInvalidState('child-element', componentKey)
                        return
                    }
                    ++elementCounter
                    const marker: Marker = {
                        endMarker: false,
                        startMarker: false,
                        endTag: null,
                        nextEndMarker: null,
                    }
                    currentRange.markers[elementCounter] = marker
                    current = { range: currentRange, marker }
                    if (
                        !elements?.onEnd(element, () => {
                            marker.endTag = elementCounter
                        })
                    ) {
                        marker.endTag = elementCounter
                    }
                },
            }
            return [
                {
                    componentKey,
                    container: componentBehavior.metadata.cssSelector,
                    visitor,
                    handlers: entries.filter((e): e is Handler => !!e),
                },
            ]
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

    await session.transform(response.clone()).text()
    return { markers, componentsWithInvalidSelectors }
}
