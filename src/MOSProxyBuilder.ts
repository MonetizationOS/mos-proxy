import type { ClientMetadataProvider } from './adapters/ClientMetadataProvider'
import type { Fetcher } from './adapters/Fetcher'
import type { HtmlRewriterAdapter } from './adapters/HtmlRewriterAdapter'
import type { MOSProxyLogger } from './logger'
import { MOSProxy, type MOSProxyHtmlPipelineErrorHandler, type MOSProxyOptions } from './MOSProxy'
import type { MOSConfigInput } from './types'

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
    private _config: MOSConfigInput | null = null
    private _originFetcher: Fetcher = globalThis.fetch
    private _apiFetcher: Fetcher = globalThis.fetch
    private _htmlRewriter: HtmlRewriterAdapter | null = null
    private _clientMetadataProvider: ClientMetadataProvider | null = null
    private _logger: MOSProxyLogger | null = null
    private _onHtmlPipelineError: MOSProxyHtmlPipelineErrorHandler | null = null
    private _customEndpoints = true
    private _linkRewriting = true
    private _surfaceDecisions = true
    private _htmlTransformation = true

    withConfig(config: MOSConfigInput): this {
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
            logger: this._logger ?? undefined,
            onHtmlPipelineError: this._onHtmlPipelineError ?? undefined,
            customEndpointsEnabled: this._customEndpoints,
            linkRewritingEnabled: this._linkRewriting,
            surfaceDecisionsEnabled: this._surfaceDecisions,
            htmlTransformationEnabled: this._htmlTransformation,
        }
        return new MOSProxy(opts)
    }
}
