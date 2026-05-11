import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { PipelineContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import { buildReplacementHandlers } from './buildReplacementHandlers'
import { ContentElementHandler } from './ContentElementHandler'
import { findMarkerPositions } from './findMarkerPositions'

export default async function handleSurfaceComponents(
    ctx: PipelineContext,
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
): Promise<Response> {
    if (surfaceDecisions.componentsSkipped) {
        return response
    }

    const { config, logger } = ctx
    const supportsRangeReplacement = rewriter.capabilities.onEndTag
    const { markers, componentsWithInvalidSelectors } = supportsRangeReplacement
        ? await findMarkerPositions(ctx, response, surfaceDecisions, rewriter)
        : { markers: {}, componentsWithInvalidSelectors: [] }

    let doRewrite = false
    let session = rewriter.create()

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

        if (supportsRangeReplacement && !componentsWithInvalidSelectors.includes(componentKey)) {
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
