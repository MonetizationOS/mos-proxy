import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { ComponentStageContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import { buildReplacementHandlers, type ReplacementHandlers } from './buildReplacementHandlers'
import { ContentElementHandler } from './ContentElementHandler'
import { findMarkerPositions } from './findMarkerPositions'
import { planRangeCut, type RangeCut } from './rangeCut'
import { createRangeElements, type RangeElements } from './rangeElements'

export default async function handleSurfaceComponents(
    ctx: ComponentStageContext,
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
): Promise<Response> {
    if (surfaceDecisions.componentsSkipped) {
        return response
    }

    const rangeCut = rewriter.capabilities.onEndTag && response.body ? planRangeCut(ctx, surfaceDecisions) : null
    if (!rangeCut) {
        return applyComponents(ctx, response, surfaceDecisions, rewriter, null)
    }

    // Buffered, because whether the fast path can cut the page is only known once pass 1 has read all of it
    const page = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    const init = { status: response.status, statusText: response.statusText, headers }
    const marked = await applyComponents(ctx, new Response(page, init), surfaceDecisions, rewriter, rangeCut)
    const markedPage = new Uint8Array(await marked.arrayBuffer())
    const cut = rangeCut.fallbackReason() ? null : await rangeCut.cut(markedPage, rewriter, headers)
    if (!cut) {
        return applyComponents(ctx, new Response(page, init), surfaceDecisions, rewriter, null)
    }
    return new Response(cut, init)
}

/** With no `rangeCut`, ranges are cut element by element. */
export async function applyComponents(
    ctx: ComponentStageContext,
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
    rangeCut: RangeCut | null,
): Promise<Response> {
    const { config, logger } = ctx
    const supportsRangeReplacement = rewriter.capabilities.onEndTag
    const { markers, componentsWithInvalidSelectors } =
        supportsRangeReplacement && !rangeCut
            ? await findMarkerPositions(ctx, response, surfaceDecisions, rewriter)
            : { markers: {}, componentsWithInvalidSelectors: [] }

    let doRewrite = false
    let session = rewriter.create()
    const registerRangeCut = (handlers: RangeCut['handlers']) => {
        for (const { selector, handler } of handlers) {
            try {
                session = session.on(selector, handler)
                doRewrite = true
            } catch {
                rangeCut?.fallBack('handler-rejected')
            }
        }
    }
    // Ahead of every other component, so what they prepend or append to a container lands outside its boundaries
    registerRangeCut(rangeCut?.handlers ?? [])

    let elements: RangeElements | null = null
    const onEnd: RangeElements['onEnd'] = (element, callback) => elements?.onEnd(element, callback) ?? false
    const components = Object.entries(surfaceDecisions.componentBehaviors).flatMap(([componentKey, componentBehavior]) => {
        const selector = componentBehavior.metadata.cssSelector
        if (!selector || !componentBehavior.content) {
            return []
        }

        if (selector.includes(':last-child')) {
            logger.log({
                level: 'warn',
                code: 'component-selector-unsupported',
                message: 'Ignoring component with unsupported CSS selector.',
                context: { componentKey, selector },
            })
            return []
        }

        let range: ReplacementHandlers | null = null
        const cutFast = rangeCut?.componentKeys.includes(componentKey)
        if (supportsRangeReplacement && !cutFast && !componentsWithInvalidSelectors.includes(componentKey)) {
            range = buildReplacementHandlers(ctx, componentBehavior, markers[componentKey], onEnd)
        } else if (!supportsRangeReplacement && componentBehavior.content.replaceRange) {
            logger.log({
                level: 'warn',
                code: 'component-range-replacement-skipped',
                message: 'Range replacement skipped: HTML rewriter adapter does not support onEndTag.',
                context: { componentKey },
            })
        }
        return [{ componentKey, selector, content: componentBehavior.content, range }]
    })

    const ranged = components.flatMap(({ range }) => (range ? [range] : []))
    if (ranged.length) {
        elements = createRangeElements(
            ranged.map(({ container }) => container.selector),
            ranged.map(({ visitor }) => visitor),
        )
    }
    // Registered with the first range component, so it starts each element before any range handler runs and
    // components ahead of the ranges still see an element before a range removes it
    let elementsRegistered = false
    const registerElements = () => {
        if (!elements || elementsRegistered) {
            return
        }
        elementsRegistered = true
        try {
            session = session.on(elements.handler.selector, elements.handler.handler)
            doRewrite = true
        } catch (error) {
            // The marker pass registered these selectors, so this is not expected
            logger.log({
                level: 'error',
                code: 'component-transform-failed',
                message: 'Failed to register range transforms; skipping range replacement.',
                context: { selector: elements.handler.selector },
                error,
            })
            elements = null
        }
    }

    for (const { componentKey, selector: componentSelector, content, range } of components) {
        if (range) {
            registerElements()
        }
        const handlers: { selector: string; handler: Parameters<typeof session.on>[1] }[] = [
            {
                selector: componentSelector,
                handler: new ContentElementHandler(ctx, content),
            },
        ]
        if (range && elements) {
            handlers.push(range.container)
        }

        for (const { selector, handler } of handlers) {
            try {
                session = session.on(selector, handler)
                doRewrite = true
            } catch (error) {
                logger.log({
                    level: 'error',
                    code: 'component-transform-failed',
                    message: 'Failed to register component transform; skipping this handler.',
                    context: { componentKey, selector: componentSelector },
                    error,
                })
            }
        }
    }

    if (config.injectScriptUrl) {
        const scriptUrl = config.injectScriptUrl
        session = session.on('head', {
            element(element) {
                element.append(`<script src="${scriptUrl}" async defer></script>`, { html: true })
            },
        })
    }

    return doRewrite ? session.transform(response) : response
}
