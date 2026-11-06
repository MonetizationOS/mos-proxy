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
    markers: Marker[]
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
            let currentRange: ComponentRange | null = null
            // Open containers; a container inside another one is part of the outer one's range
            let depth = 0

            const entries: (Handler | null)[] = [
                {
                    selector: `${componentBehavior.metadata.cssSelector}`,
                    componentKey,
                    handler: {
                        element: (element: RewriterElement) => {
                            if (depth > 0) {
                                return
                            }
                            currentRange = { markers: [] }
                            markers[componentKey]?.push(currentRange)
                            // With no end tag, nothing can be nested in it
                            if (
                                elements?.onEnd(element, () => {
                                    depth--
                                })
                            ) {
                                depth++
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
                                  if (!currentRange) {
                                      logInvalidState('to-marker', componentKey)
                                      return
                                  }
                                  const marker = currentRange.markers[elementCounter]
                                  if (marker) {
                                      marker.endMarker = true
                                  }
                                  for (let i = elementCounter; i >= 1; i--) {
                                      const m = currentRange.markers[i]
                                      if (m && !m.nextEndMarker) {
                                          m.nextEndMarker = elementCounter
                                      } else {
                                          break
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
                                  if (!currentRange) {
                                      logInvalidState('from-marker', componentKey)
                                      return
                                  }
                                  const marker = currentRange.markers[elementCounter]
                                  if (marker) {
                                      marker.startMarker = true
                                  }
                              },
                          },
                      }
                    : null,
            ]
            const visitor: RangeVisitor = {
                open: () => depth > 0,
                child(element: RewriterElement) {
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
