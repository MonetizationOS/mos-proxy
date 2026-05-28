import type { ClientMetadataProvider } from './adapters/ClientMetadataProvider'
import type { Fetcher } from './adapters/Fetcher'
import type { HtmlRewriterAdapter } from './adapters/HtmlRewriterAdapter'
import { type MOSConfig, normalizeMOSConfig } from './config'
import type { PipelineContext } from './context'
import { consoleLogger, type MOSProxyLogger } from './logger'
import customEndpointRequest from './stages/customEndpoint'
import isRedirectResponse from './stages/isRedirectResponse'
import rewriteOriginResponse from './stages/linkRewriting'
import performOriginRequest from './stages/originRequest'
import shouldIgnorePath from './stages/shouldIgnorePath'
import handleSurfaceBehavior from './stages/surfaceBehavior'
import handleSurfaceComponents from './stages/surfaceComponents'
import getSurfaceDecisions from './stages/surfaceDecisions'
import type { MOSConfigInput, MOSProxyApiRetryHandler } from './types'

export type MOSProxyHtmlPipelineStage =
    | 'origin-response'
    | 'link-rewriting'
    | 'surface-decisions'
    | 'surface-behavior'
    | 'surface-components'

export interface MOSProxyHtmlPipelineErrorContext {
    error: unknown
    stage: MOSProxyHtmlPipelineStage
    request: Request
    lastSafeResponse: Response
}

/**
 * Called when the HTML pipeline throws. Return a `Response` to fully control the proxy's reply, or
 * re-throw to surface the error to the platform handler. If omitted, the proxy fails open and
 * returns `lastSafeResponse`. If the callback itself throws or returns a non-Response value, the
 * proxy logs a warning and falls back to `lastSafeResponse` so the site cannot be taken down by a
 * bug in the handler.
 */
export type MOSProxyHtmlPipelineErrorHandler = (ctx: MOSProxyHtmlPipelineErrorContext) => Response | Promise<Response>

export interface MOSProxyOptions {
    config: MOSConfigInput
    originFetcher: Fetcher
    apiFetcher: Fetcher | null
    htmlRewriter: HtmlRewriterAdapter | null
    clientMetadataProvider: ClientMetadataProvider | null
    logger?: MOSProxyLogger
    onHtmlPipelineError?: MOSProxyHtmlPipelineErrorHandler
    onApiRetry?: MOSProxyApiRetryHandler
    customEndpointsEnabled: boolean
    linkRewritingEnabled: boolean
    surfaceDecisionsEnabled: boolean
    htmlTransformationEnabled: boolean
}

/**
 * Platform-agnostic MonetizationOS proxy. Build one with `MOSProxyBuilder`, then call
 * `proxy.handle(request)` from your platform's fetch entry point.
 */
export class MOSProxy {
    private readonly config: MOSConfig

    constructor(private readonly opts: MOSProxyOptions) {
        this.config = normalizeMOSConfig(opts.config, opts.logger ?? consoleLogger)
    }

    async handle(request: Request): Promise<Response> {
        const {
            originFetcher,
            apiFetcher,
            htmlRewriter,
            clientMetadataProvider,
            onHtmlPipelineError,
            onApiRetry,
            logger = consoleLogger,
        } = this.opts
        const ctx: PipelineContext = { config: this.config, logger }

        // Stage 1a: custom endpoint routing
        if (this.opts.customEndpointsEnabled) {
            if (!apiFetcher) {
                throw new Error('MOSProxy: customEndpoints is enabled but no API fetcher is configured')
            }
            const customEndpointResponse = await customEndpointRequest(ctx, request, apiFetcher)
            if (customEndpointResponse) {
                return customEndpointResponse
            }
        }

        // Stage 1b: origin fetch
        const originResponse = await performOriginRequest(ctx, request, originFetcher)

        // Auto-skip HTML pipeline for non-HTML content, or when HTML transformation is disabled entirely
        const isHtml = originResponse.headers.get('Content-Type')?.startsWith('text/html') ?? false
        if (!isHtml || !this.opts.htmlTransformationEnabled) {
            return originResponse
        }

        let stage: MOSProxyHtmlPipelineStage = 'origin-response'
        let failOpenResponse = cloneResponseForFallback(originResponse, logger, stage)

        try {
            // Stage 2: rewrite origin links (optional)
            let rewrittenResponse: Response = originResponse
            if (this.opts.linkRewritingEnabled) {
                stage = 'link-rewriting'
                rewrittenResponse = await rewriteOriginResponse(ctx, request, originResponse)
                failOpenResponse = cloneResponseForFallback(rewrittenResponse, logger, stage)
            }

            // Stage 3: surface decisions (optional)
            if (!this.opts.surfaceDecisionsEnabled) {
                return rewrittenResponse
            }
            if (shouldIgnorePath(ctx, request) || isRedirectResponse(rewrittenResponse)) {
                return rewrittenResponse
            }

            if (!apiFetcher) {
                throw new Error('MOSProxy: surfaceDecisions is enabled but no API fetcher is configured')
            }

            stage = 'surface-decisions'
            const [modifiedResponse, surfaceDecisions] = await getSurfaceDecisions(
                ctx,
                request,
                rewrittenResponse,
                apiFetcher,
                htmlRewriter,
                clientMetadataProvider,
                onApiRetry,
            )
            if (!surfaceDecisions) {
                return modifiedResponse
            }
            failOpenResponse = cloneResponseForFallback(modifiedResponse, logger, stage)

            // Stage 4: surface behavior (HTTP-level)
            stage = 'surface-behavior'
            const [surfaceDecisionResponse, returnImmediately] = handleSurfaceBehavior(modifiedResponse, surfaceDecisions)
            if (returnImmediately) {
                return surfaceDecisionResponse
            }
            failOpenResponse = cloneResponseForFallback(surfaceDecisionResponse, logger, stage)

            // Stage 5: surface components (HTML-level) — requires an HTML rewriter
            if (!htmlRewriter) {
                return surfaceDecisionResponse
            }
            stage = 'surface-components'
            return await handleSurfaceComponents(ctx, surfaceDecisionResponse, surfaceDecisions, htmlRewriter)
        } catch (error) {
            logger.log({
                level: 'error',
                code: 'html-pipeline-failed',
                message: 'HTML pipeline failed.',
                context: { stage, hasErrorHandler: Boolean(onHtmlPipelineError) },
                error,
            })

            if (!onHtmlPipelineError) {
                return failOpenResponse
            }

            try {
                const handlerResponse = await onHtmlPipelineError({
                    error,
                    stage,
                    request,
                    lastSafeResponse: failOpenResponse,
                })
                if (!(handlerResponse instanceof Response)) {
                    logger.log({
                        level: 'warn',
                        code: 'html-pipeline-error-handler-invalid',
                        message: 'onHtmlPipelineError did not return a Response; falling back to the last safe response.',
                        context: { stage },
                    })
                    return failOpenResponse
                }
                return handlerResponse
            } catch (handlerError) {
                logger.log({
                    level: 'warn',
                    code: 'html-pipeline-error-handler-threw',
                    message: 'onHtmlPipelineError threw; falling back to the last safe response.',
                    context: { stage },
                    error: handlerError,
                })
                return failOpenResponse
            }
        }
    }
}

const cloneResponseForFallback = (response: Response, logger: MOSProxyLogger, stage: MOSProxyHtmlPipelineStage): Response => {
    try {
        return response.clone()
    } catch (error) {
        logger.log({
            level: 'warn',
            code: 'response-clone-failed',
            message: 'Could not clone response for fail-open fallback.',
            context: { stage },
            error,
        })
        return response
    }
}
