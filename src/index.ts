export type {
    ClientMetadataProvider,
    ContentOptions,
    ElementHandlers,
    Fetcher,
    HtmlRewriterAdapter,
    HtmlRewriterCapabilities,
    HtmlRewriterSession,
    Identity,
    IdentityProvider,
    PersistIdentityArgs,
    ResolveIdentityArgs,
    Resource,
    ResourceProvider,
    RewriterElement,
    RewriterText,
} from './adapters'
export {
    buildIdentity,
    defaultPersistIdentity,
    defaultResolveIdentity,
    getExistingCookies,
} from './adapters'
export type { MOSConfig } from './config'
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
    MOSConfigInput,
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
