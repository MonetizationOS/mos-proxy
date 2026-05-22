export type {
    ClientMetadataProvider,
    ContentOptions,
    ElementHandlers,
    Fetcher,
    HtmlRewriterAdapter,
    HtmlRewriterCapabilities,
    HtmlRewriterSession,
    RewriterElement,
    RewriterText,
} from './adapters'
export type { MOSProxyLogCode, MOSProxyLogEvent, MOSProxyLogger, MOSProxyLogLevel } from './logger'
export {
    MOSProxy,
    type MOSProxyHtmlPipelineErrorContext,
    type MOSProxyHtmlPipelineErrorHandler,
    type MOSProxyHtmlPipelineStage,
    type MOSProxyOptions,
} from './MOSProxy'
export { MOSProxyBuilder } from './MOSProxyBuilder'
export type {
    Feature,
    FeatureMeterableProperty,
    FeatureNumberProperty,
    FetchSurfaceDecisionsFailureReason,
    MOSConfigInput,
    MOSProxyApiRetryContext,
    MOSProxyApiRetryHandler,
    MOSProxyApiRetryResult,
    ModifyHttpResponse,
    PageMetadata,
    SetHttpResponse,
    SubSurfaceBehaviorApi,
    SubSurfaceMetadataApi,
    SurfaceBehaviorApi,
    SurfaceDecisionError,
    SurfaceDecisionResponse,
    WebComponentElement,
    WebComponentRangeReplacement,
    WebContentSurfaceBehavior,
    WebElement,
} from './types'
