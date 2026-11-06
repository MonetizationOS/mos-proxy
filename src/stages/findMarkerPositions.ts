import type { ElementHandlers, HtmlRewriterAdapter, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import { isVoidElement } from './voidElements'
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

    const handlers: Handler[] = Object.entries(surfaceDecisions.componentBehaviors).flatMap<Handler>(
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
                            if (element.onEndTag && !isVoidElement(element)) {
                                try {
                                    element.onEndTag(() => {
                                        depth--
                                    })
                                    depth++
                                } catch {
                                    // No end tag, so nothing can be nested in it
                                }
                            }
                        },
                    },
                },
                {
                    selector: combineSelectors(componentBehavior.metadata.cssSelector, ' ', '*'),
                    componentKey,
                    handler: {
                        element(element: RewriterElement) {
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
                            if (element.onEndTag && !isVoidElement(element)) {
                                try {
                                    element.onEndTag(() => {
                                        marker.endTag = elementCounter
                                    })
                                } catch {
                                    marker.endTag = elementCounter
                                }
                            } else {
                                marker.endTag = elementCounter
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
            return entries.filter((e): e is Handler => !!e)
        },
    )

    if (!handlers.length || !response.body) {
        return { markers, componentsWithInvalidSelectors: [] }
    }

    const componentsWithInvalidSelectors: string[] = []
    let session = rewriter.create()
    for (const { selector, handler, componentKey } of handlers) {
        try {
            session = session.on(selector, handler)
        } catch (error) {
            ctx.logger.log({
                level: 'error',
                code: 'marker-pass-selector-failed',
                message: 'Failed to register marker-pass handler for component selector; skipping range replacement for this component.',
                context: { selector, componentKey },
                error,
            })
            componentsWithInvalidSelectors.push(componentKey)
        }
    }

    await session.transform(response.clone()).text()
    return { markers, componentsWithInvalidSelectors }
}
