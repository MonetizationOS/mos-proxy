import type { HtmlRewriterAdapter } from './adapters/HtmlRewriterAdapter'
import type { MOSProxyLogger } from './logger'
import { parsePageMetadata as parsePageMetadataStage } from './stages/pageMetadata'
import handleSurfaceComponents from './stages/surfaceComponents'
import type { PageMetadata, SurfaceDecisionResponse } from './types'

/**
 * The proxy's HTML stages, for callers that hold the page themselves, such as MOS rewriting a page a proxy sent it.
 * A page comes out the same as it would through `MOSProxy`.
 */
export interface ComponentBehaviorOptions {
    logger: MOSProxyLogger
    /** Inject this script into `<head>`, as the proxy's `injectScriptUrl` config does. */
    injectScriptUrl?: string
}

/** Applies a decision's `componentBehaviors` to an HTML response. */
export function applyComponentBehaviors(
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
    { logger, injectScriptUrl }: ComponentBehaviorOptions,
): Promise<Response> {
    return handleSurfaceComponents({ logger, config: { injectScriptUrl } }, response, surfaceDecisions, rewriter)
}

/** Reads `<meta name|property content>` pairs from an HTML response, as sent in `resource.meta`. */
export function parsePageMetadata(
    response: Response,
    rewriter: HtmlRewriterAdapter,
    { logger }: { logger: MOSProxyLogger },
): Promise<PageMetadata> {
    return parsePageMetadataStage({ logger }, response, rewriter)
}
