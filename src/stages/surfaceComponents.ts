import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { ComponentStageContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import { buildReplacementHandlers } from './buildReplacementHandlers'
import { ContentElementHandler } from './ContentElementHandler'
import { findMarkerPositions } from './findMarkerPositions'
import { planRangeWrapper, type RangeWrapper } from './wrappedRange'

export default async function handleSurfaceComponents(
    ctx: ComponentStageContext,
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
): Promise<Response> {
    if (surfaceDecisions.componentsSkipped) {
        return response
    }

    const wrapper = rewriter.capabilities.onEndTag && response.body ? planRangeWrapper(ctx, surfaceDecisions) : null
    if (!wrapper) {
        return applyComponents(ctx, response, surfaceDecisions, rewriter, null)
    }

    // Buffered, because whether the wrapper can cut the page is only known once pass 1 has read all of it
    const page = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    const init = { status: response.status, statusText: response.statusText, headers }
    const wrapped = await applyComponents(ctx, new Response(page, init), surfaceDecisions, rewriter, wrapper)
    const wrappedPage = await wrapped.arrayBuffer()
    if (wrapper.unsupported()) {
        return applyComponents(ctx, new Response(page, init), surfaceDecisions, rewriter, null)
    }
    if (wrapper.wrapped() === 0) {
        return new Response(wrappedPage, init)
    }
    let unwrap = rewriter.create()
    for (const { selector, handler } of wrapper.unwrap) {
        unwrap = unwrap.on(selector, handler)
    }
    return unwrap.transform(new Response(wrappedPage, init))
}

/** With no `wrapper`, ranges are cut element by element. */
export async function applyComponents(
    ctx: ComponentStageContext,
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
    wrapper: RangeWrapper | null,
): Promise<Response> {
    const { config, logger } = ctx
    const supportsRangeReplacement = rewriter.capabilities.onEndTag
    const { markers, componentsWithInvalidSelectors } =
        supportsRangeReplacement && !wrapper
            ? await findMarkerPositions(ctx, response, surfaceDecisions, rewriter)
            : { markers: {}, componentsWithInvalidSelectors: [] }

    let doRewrite = false
    let session = rewriter.create()
    const registerWrapper = (handlers: RangeWrapper['handlers']) => {
        for (const { selector, handler } of handlers) {
            try {
                session = session.on(selector, handler)
                doRewrite = true
            } catch {
                wrapper?.fail()
            }
        }
    }
    // Ahead of every other component, so what they insert lands outside the wrapper
    registerWrapper(wrapper?.handlers ?? [])

    Object.entries(surfaceDecisions.componentBehaviors).forEach(([componentKey, componentBehavior]) => {
        if (!componentBehavior.metadata.cssSelector || !componentBehavior.content) {
            return
        }

        if (componentBehavior.metadata.cssSelector.includes(':last-child')) {
            logger.log({
                level: 'warn',
                code: 'component-selector-unsupported',
                message: 'Ignoring component with unsupported CSS selector.',
                context: { componentKey, selector: componentBehavior.metadata.cssSelector },
            })
            return
        }

        const handlers: { selector: string; handler: Parameters<typeof session.on>[1] }[] = [
            {
                selector: componentBehavior.metadata.cssSelector,
                handler: new ContentElementHandler(ctx, componentBehavior.content),
            },
        ]

        const cutByWrapper = wrapper?.componentKeys.includes(componentKey)
        if (supportsRangeReplacement && !cutByWrapper && !componentsWithInvalidSelectors.includes(componentKey)) {
            handlers.push(...buildReplacementHandlers(ctx, componentBehavior, markers[componentKey]))
        } else if (!supportsRangeReplacement && componentBehavior.content.replaceRange) {
            logger.log({
                level: 'warn',
                code: 'component-range-replacement-skipped',
                message: 'Range replacement skipped: HTML rewriter adapter does not support onEndTag.',
                context: { componentKey },
            })
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
                    context: { componentKey, selector: componentBehavior.metadata.cssSelector },
                    error,
                })
            }
        }
    })

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
