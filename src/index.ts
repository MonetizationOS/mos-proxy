export type {
    ClientIPProvider,
    ClientMetadataProvider,
    ConfigFactory,
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
    UnresolvedConfigContext,
    UnresolvedConfigHandler,
    UnresolvedConfigReason,
} from './adapters'
export {
    buildIdentity,
    defaultPersistIdentity,
    defaultResolveIdentity,
    getExistingCookies,
} from './adapters'
export type { MOSConfig } from './config'
export { ConfigUnresolvableError } from './configResolution'
export { type HostPathRule, hostPathMatcher } from './hostPathMatcher'
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
