// PROTOTYPE — throwaway. See README.md.
import {
    ConfigUnresolvableError,
    MOSProxy,
    MOSProxyBuilder,
    buildIdentity,
    defaultPersistIdentity,
    defaultResolveIdentity,
    getExistingCookies,
    hostPathMatcher,
} from '@monetizationos/proxy'

const namedExports = {
    ConfigUnresolvableError,
    MOSProxy,
    MOSProxyBuilder,
    buildIdentity,
    defaultPersistIdentity,
    defaultResolveIdentity,
    getExistingCookies,
    hostPathMatcher,
}

const originFetcher = async () =>
    new Response('<html><body>origin said hello</body></html>', {
        headers: { 'content-type': 'text/html' },
    })

const proxy = new MOSProxyBuilder()
    .withConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'prototype-not-a-real-key',
        mosEndpointsPrefix: '/mos-endpoints/',
        anonymousSessionCookieName: 'anon-session-id',
        authenticatedUserJwtCookieName: '__session',
        surfaceDecisionsIgnorePaths: '',
        originRequestHeaders: {},
        createAnonymousIdentifierFallback: true,
    })
    .withOriginFetcher(originFetcher)
    .withoutCustomEndpoints()
    .withoutSurfaceDecisions()
    .withoutHtmlTransformation()
    .build()

export default {
    async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== '/__probe') {
            return proxy.handle(request)
        }

        const proxied = await proxy.handle(new Request('https://site.example.com/article'))
        const matcher = hostPathMatcher([{ host: 'site.example.com', config: { surfaceSlug: 'web' } }])

        return Response.json({
            runtime: navigator.userAgent,
            hasHTMLRewriter: typeof HTMLRewriter !== 'undefined',
            missingExports: Object.entries(namedExports)
                .filter(([, value]) => value === undefined)
                .map(([name]) => name),
            proxyHandleStatus: proxied.status,
            proxyBody: (await proxied.text()).slice(0, 40),
            hostPathMatcherReturns: typeof matcher,
        })
    },
}
