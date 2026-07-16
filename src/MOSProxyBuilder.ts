import type { ClientIPProvider } from './adapters/ClientIPProvider'
import type { ClientMetadataProvider } from './adapters/ClientMetadataProvider'
import type { ConfigFactory, UnresolvedConfigHandler } from './adapters/ConfigFactory'
import type { Fetcher } from './adapters/Fetcher'
import type { HtmlRewriterAdapter } from './adapters/HtmlRewriterAdapter'
import type { IdentityProvider } from './adapters/IdentityProvider'
import type { ResourceProvider } from './adapters/ResourceProvider'
import type { MOSProxyLogger } from './logger'
import { MOSProxy, type MOSProxyHtmlPipelineErrorHandler, type MOSProxyOptions } from './MOSProxy'
import type { MOSConfigInput, MosAuthenticatedApiRoute } from './types'

/**
 * Fluent builder for `MOSProxy`. Provide configuration and platform adapters, then `build()`.
 *
 * Defaults:
 * - custom endpoint routing: enabled
 * - link rewriting: enabled
 * - surface decisions: enabled
 * - HTML transformation: enabled (auto-skipped per request for non-HTML responses)
 * - origin/API fetcher: `globalThis.fetch` (override on runtimes that need a backend binding, e.g. Fastly)
 *
 * @example
 * ```ts
 * const proxy = new MOSProxyBuilder()
 *     .withConfig({
 *         originUrl: 'https://news.example.com',
 *         surfaceSlug: 'web',
 *         mosHost: 'https://api.monetizationos.com',
 *         mosSecretKey: process.env.MONETIZATION_OS_SECRET_KEY!,
 *         mosEndpointsPrefix: '/mos-endpoints/',
 *         anonymousSessionCookieName: 'anon-session-id',
 *         authenticatedUserJwtCookieName: '__session',
 *         injectScriptUrl: 'https://assets.monetizationos.com/web-components-latest.js',
 *         surfaceDecisionsIgnorePaths: '',
 *         // Optional: forward specific cookies to surface decisions
 *         surfaceDecisionsCookies: '^__session$, ^theme$',
 *         originRequestHeaders: { 'X-Api-Key': process.env.ORIGIN_API_KEY! },
 *         createAnonymousIdentifierFallback: true,
 *     })
 *     .withHtmlRewriter(myHtmlRewriterAdapter)
 *     .build()
 *
 * export default { fetch: (request: Request) => proxy.handle(request) }
 * ```
 */
export class MOSProxyBuilder {
    private _config: MOSConfigInput | ConfigFactory | null = null
    private _originFetcher: Fetcher = globalThis.fetch
    private _apiFetcher: Fetcher = globalThis.fetch
    private _htmlRewriter: HtmlRewriterAdapter | null = null
    private _clientMetadataProvider: ClientMetadataProvider | null = null
    private _clientIpProvider: ClientIPProvider | null = null
    private _identityProvider: IdentityProvider | null = null
    private _resourceProvider: ResourceProvider | null = null
    private _onUnresolvedConfig: UnresolvedConfigHandler | null = null
    private _configCacheSize: number | null = null
    private _logger: MOSProxyLogger | null = null
    private _onHtmlPipelineError: MOSProxyHtmlPipelineErrorHandler | null = null
    private _customEndpoints = true
    private _linkRewriting = true
    private _surfaceDecisions = true
    private _htmlTransformation = true
    private _additionalAuthenticatedApiRoutes: MosAuthenticatedApiRoute[] = []

    /**
     * Sets the proxy configuration. Pass a {@link MOSConfigInput} for one fixed config, or a
     * {@link ConfigFactory} to compute a full config per request so one deployment can front several
     * brands. A factory returns the complete config (you merge shared fields with per-brand values
     * yourself). See {@link hostPathMatcher} for a ready-made host/path table, and
     * {@link withUnresolvedConfigHandler} for requests it can't resolve.
     */
    withConfig(config: MOSConfigInput | ConfigFactory): this {
        this._config = config
        return this
    }

    withOriginFetcher(fetcher: Fetcher): this {
        this._originFetcher = fetcher
        return this
    }

    withApiFetcher(fetcher: Fetcher): this {
        this._apiFetcher = fetcher
        return this
    }

    withHtmlRewriter(rewriter: HtmlRewriterAdapter): this {
        this._htmlRewriter = rewriter
        return this
    }

    withClientMetadata(provider: ClientMetadataProvider): this {
        this._clientMetadataProvider = provider
        return this
    }

    /**
     * Supplies the end-user client IP for MOS API requests as `http.clientIP`.
     * Each CDN runtime knows how to read the visitor IP from its own request object.
     */
    withClientIP(provider: ClientIPProvider): this {
        this._clientIpProvider = provider
        return this
    }

    /**
     * Override identity provision for the surface-decisions API. Provide `resolve` to control the
     * identity payload sent to the API (e.g. resolved from a request header instead of cookies),
     * and/or `persist` to control how identity is recorded back on the response (e.g. suppress the
     * default anonymous-session cookie or write it elsewhere). Either method is optional; omitted
     * methods fall back to the built-in defaults.
     */
    withIdentityProvider(provider: IdentityProvider): this {
        this._identityProvider = provider
        return this
    }

    /**
     * Override the resource object sent to the surface-decisions API per request. `build` receives
     * only the `Request`; the proxy derives defaults (`{ id: pathname, meta: pageMetadata }`) and
     * shallow-merges your returned record over them. Return only the keys you want to add or
     * override (e.g. a content tier or canonical id) — `id`/`meta` are preserved unless you set them.
     */
    withResourceProvider(provider: ResourceProvider): this {
        this._resourceProvider = provider
        return this
    }

    /**
     * Handles requests a {@link ConfigFactory} couldn't resolve (it threw or returned a config that
     * wouldn't normalize). Return a `Response` to fail closed (e.g. a 404 for an unknown host), or
     * return nothing to fall through to that host's last-known-good config. With no handler and no
     * last-known-good config for the host, the error propagates instead of serving another brand's config.
     */
    withUnresolvedConfigHandler(handler: UnresolvedConfigHandler): this {
        this._onUnresolvedConfig = handler
        return this
    }

    /**
     * Max number of normalized configs to keep in memory. Defaults to 256; raise it above your
     * live brand count if a deployment fronts more than that.
     */
    withConfigCacheSize(max: number): this {
        this._configCacheSize = max
        return this
    }

    withLogger(logger: MOSProxyLogger): this {
        this._logger = logger
        return this
    }

    /**
     * Register a callback to handle HTML pipeline errors. The proxy fails open by default and
     * returns the last safe (unconsumed) response — provide this if you want to shape that
     * response yourself (e.g. render a custom error page, return a 503, or re-throw so your
     * platform's error middleware handles it). If the callback throws or returns a non-Response
     * value, the proxy logs a warning and falls back to the last safe response.
     */
    withHtmlPipelineErrorHandler(handler: MOSProxyHtmlPipelineErrorHandler): this {
        this._onHtmlPipelineError = handler
        return this
    }

    withoutCustomEndpoints(): this {
        this._customEndpoints = false
        return this
    }

    withoutLinkRewriting(): this {
        this._linkRewriting = false
        return this
    }

    withoutSurfaceDecisions(): this {
        this._surfaceDecisions = false
        return this
    }

    /**
     * Disable the HTML transformation pipeline entirely (stages 3–6).
     *
     * Use for API-only proxies: neither an HTML rewriter adapter nor an API fetcher is required
     * if custom endpoints and surface decisions are both disabled alongside this.
     */
    withoutHtmlTransformation(): this {
        this._htmlTransformation = false
        return this
    }

    /**
     * Add an additional route which, when matched by an incoming request, will be forwarded to the MonetizationOS API
     * with authentication handled by the configured identity provider.
     * This is in addition to the default `/mos-api/offer-redemptions` route.
     */
    withMosAuthenticatedApiRoutes(...routes: MosAuthenticatedApiRoute[]): this {
        this._additionalAuthenticatedApiRoutes.push(...routes)
        return this
    }

    build(): MOSProxy {
        if (!this._config) {
            throw new Error('MOSProxyBuilder: withConfig(...) is required')
        }

        const needsHtmlRewriter = this._htmlTransformation && this._surfaceDecisions
        if (needsHtmlRewriter && !this._htmlRewriter) {
            throw new Error(
                'MOSProxyBuilder: withHtmlRewriter(...) is required when surface decisions is enabled; call withoutSurfaceDecisions() or withoutHtmlTransformation() if you do not need it',
            )
        }

        const opts: MOSProxyOptions = {
            config: this._config,
            originFetcher: this._originFetcher,
            apiFetcher: this._apiFetcher,
            htmlRewriter: this._htmlRewriter,
            clientMetadataProvider: this._clientMetadataProvider,
            clientIpProvider: this._clientIpProvider,
            identityProvider: this._identityProvider,
            resourceProvider: this._resourceProvider,
            onUnresolvedConfig: this._onUnresolvedConfig ?? undefined,
            maxCachedConfigs: this._configCacheSize ?? undefined,
            logger: this._logger ?? undefined,
            onHtmlPipelineError: this._onHtmlPipelineError ?? undefined,
            customEndpointsEnabled: this._customEndpoints,
            linkRewritingEnabled: this._linkRewriting,
            surfaceDecisionsEnabled: this._surfaceDecisions,
            htmlTransformationEnabled: this._htmlTransformation,
            mosAuthenticatedApiRoutes: [
                ...this._additionalAuthenticatedApiRoutes,
                {
                    matchPath: '/mos-api/offer-redemptions',
                    method: 'POST',
                    mosPath: '/api/v1/offer-redemptions',
                },
            ],
        }
        return new MOSProxy(opts)
    }
}
