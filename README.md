<div align="center">
  <a href="https://monetizationos.com">
  <img alt="MonetizationOS logo" src="https://app.monetizationos.com/static/monetizationos-logo.png" height="48">
  </a>
  <h1>MonetizationOS Proxy Core</h1>
</div>

A Fetch-based [MonetizationOS Proxy](https://docs.monetizationos.com/docs/api-reference/proxies) core: `Request` in, `Response` out, runtime-agnostic.

This package contains the shared pipeline that powers the MonetizationOS proxy workers on Cloudflare, Fastly, Akamai, and any other runtime that speaks the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API). Platform-specific concerns — origin dispatch, config/secret loading, HTML rewriting — are supplied by each consumer as adapters.

## Install

```sh
npm install @monetizationos/proxy
```

## Usage

```ts
import { MOSProxyBuilder } from "@monetizationos/proxy";

const proxy = new MOSProxyBuilder()
    .withConfig({
        originUrl: "https://news.example.com",
        surfaceSlug: "web",
        mosHost: "https://api.monetizationos.com",
        mosSecretKey: process.env.MONETIZATION_OS_SECRET_KEY!,
        mosEndpointsPrefix: "/mos-endpoints/",
        anonymousSessionCookieName: "anon-session-id",
        authenticatedUserJwtCookieName: "__session",
        createAnonymousIdentifierFallback: true,
        injectScriptUrl: "https://assets.monetizationos.com/web-components-latest.js",
        originRequestHeaders: { "X-Api-Key": process.env.ORIGIN_API_KEY! },
    })
    .withHtmlRewriter(myHtmlRewriterAdapter)
    .build();

export default {
    fetch: (request: Request) => proxy.handle(request),
};
```

## Pipeline

1. Custom endpoint routing (`/mos-endpoints/*` → MOS API)
2. Origin fetch
3. Link rewriting and `<meta>` extraction
4. Surface decisions
5. Surface behavior (HTTP-level mutations)
6. Surface components (DOM-level transforms)

Stages 3–6 run on HTML responses only and auto-skip for everything else. Call `.withoutHtmlTransformation()` to disable them entirely.

## Configuration

Optional fields on `MOSConfigInput`:

| Field | Description |
| --- | --- |
| `mosEndpointsPrefix` | Path prefix routed to the MonetizationOS endpoint proxy. Default: `/mos-endpoints/`. |
| `surfaceDecisionsIgnorePaths` | Comma-separated regex patterns. Matching request pathnames skip the surface-decisions call. |
| `surfaceDecisionsCookies` | Comma-separated regex patterns. Matching cookies from the incoming request and the origin `Set-Cookie` headers are forwarded to the surface-decisions API as `http.cookies` (`Record<string, string>`). Origin values win when the same name appears in both. Omitted when unset or when no cookies match. |
| `createAnonymousIdentifierFallback` | When `true` (default), JWT surface-decision requests ask MonetizationOS to mint an anonymous identifier if JWT auth fails. |
| `originRequestHeaders` | Headers added to or replacing client headers on every origin request. |
| `injectScriptUrl` | Script URL injected into the `<head>` of HTML responses. |

Example — forward specific cookies to surface decisions:

```ts
.withConfig({
    // ...
    surfaceDecisionsCookies: "^__session$, ^theme$, ^mos_",
})
```

Each entry is a regex tested against the cookie **name**. Plain names like `^__session$` match exactly; prefixes like `^mos_` match any cookie whose name starts with `mos_`.

## Adapters

- `Fetcher` — `(request: Request) => Promise<Response>`. Configure separately for origin traffic (`.withOriginFetcher`) and MOS API traffic (`.withApiFetcher`). Both default to `globalThis.fetch`; override on runtimes that need a backend binding (e.g. Fastly Compute) or custom dispatch.
- `HtmlRewriterAdapter` — wraps the platform's lol-html binding.
- `ClientMetadataProvider` — optional; exposes platform-specific request metadata (Cloudflare's `cf` object, Fastly's `event.client`, etc.).

## API-only mode

Skip HTML transformation entirely when the proxy only needs to handle API traffic:

```ts
const proxy = new MOSProxyBuilder().withConfig(config).withoutHtmlTransformation().build();
```

## Error handling and logging

The HTML pipeline fails open by default: on error, the proxy logs a structured event and returns the last safe response so the origin page still gets served. Register an error handler to shape that response yourself — render a custom error page, return a 503, or rethrow so the host runtime's error middleware takes over.

```ts
const proxy = new MOSProxyBuilder()
    .withConfig(config)
    .withHtmlRewriter(myHtmlRewriterAdapter)
    .withHtmlPipelineErrorHandler(({ error, stage, lastSafeResponse }) => {
        // Inspect `error` / `stage`, or return your own Response.
        return lastSafeResponse;
    })
    .withLogger({
        log(event) {
            console[event.level](event.message, event.context, event.error);
        },
    })
    .build();
```

## License

MIT
