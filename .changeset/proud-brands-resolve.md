---
"@monetizationos/proxy": minor
---

`MOSProxyBuilder.withConfig` now accepts either a static config object or a `ConfigFactory` function `(request) => MOSConfigInput` that computes a full config per request — so one deployment can front multiple brands. Ships a `hostPathMatcher` helper (most-specific-wins, exact hostname, segment-boundary path prefix) returning full configs; dynamic clients can back the factory with a KV lookup.

The factory returns a complete config (the caller merges shared fields with per-brand values), so there is no base to fall open to. Normalized configs are memoized in a content-keyed cache (`withConfigCacheSize`, default 256) so each distinct config compiles + warns once. On failure (the factory throws or its config can't normalize) resolution fails over: `withUnresolvedConfigHandler` runs first (return a `Response` to fail closed), then the last-known-good config for the request's *host* is served (never another host's), and if neither is available the new `ConfigUnresolvableError` propagates.
