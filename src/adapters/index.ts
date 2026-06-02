export type { ClientMetadataProvider } from './ClientMetadataProvider'
export type { Fetcher } from './Fetcher'
export type {
    ContentOptions,
    ElementHandlers,
    HtmlRewriterAdapter,
    HtmlRewriterCapabilities,
    HtmlRewriterSession,
    RewriterElement,
    RewriterText,
} from './HtmlRewriterAdapter'
export type { Identity, IdentityProvider, PersistIdentityArgs, ResolveIdentityArgs } from './IdentityProvider'
export {
    buildIdentity,
    defaultPersistIdentity,
    defaultResolveIdentity,
    getExistingCookies,
} from './IdentityProvider'
export type { Resource, ResourceProvider } from './ResourceProvider'
