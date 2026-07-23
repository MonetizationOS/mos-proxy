# @monetizationos/proxy

## 1.5.2

### Patch Changes

- [#30](https://github.com/MonetizationOS/mos-proxy/pull/30) [`9a48c30`](https://github.com/MonetizationOS/mos-proxy/commit/9a48c302d3f6a0a6f70f7b0023666cd8e5166597) Thanks [@filipe-boleto](https://github.com/filipe-boleto)! - Add `MOSProxyBuilder.withClientIP((request) => ...)` so each CDN runtime supplies the end-user IP for MOS API requests as `http.clientIP`. Applies to surface-decisions and authenticated `/mos-api/*` routes.

## 1.5.1

### Patch Changes

- [#28](https://github.com/MonetizationOS/mos-proxy/pull/28) [`0e51435`](https://github.com/MonetizationOS/mos-proxy/commit/0e514356c611114f48abacb3c95529b7cb1a5eea) Thanks [@filipe-boleto](https://github.com/filipe-boleto)! - Include Referer header in authenticated API (`/mos-api/*`) http payload, matching surface-decisions behavior since 1.4.2.

## 1.5.0

### Minor Changes

- [#26](https://github.com/MonetizationOS/mos-proxy/pull/26) [`df57fdf`](https://github.com/MonetizationOS/mos-proxy/commit/df57fdf9b4520dcbd52c16b3542a7102fcdf3faf) Thanks [@benney](https://github.com/benney)! - `MOSProxyBuilder.withConfig` now accepts either a static config object or a `ConfigFactory` function `(request) => MOSConfigInput` that computes a full config per request — so one deployment can front multiple brands. Ships a `hostPathMatcher` helper (most-specific-wins, exact hostname, segment-boundary path prefix) returning full configs; dynamic clients can back the factory with a KV lookup.

  The factory returns a complete config (the caller merges shared fields with per-brand values), so there is no base to fall open to. Normalized configs are memoized in a content-keyed cache (`withConfigCacheSize`, default 256) so each distinct config compiles + warns once. On failure (the factory throws or its config can't normalize) resolution fails over: `withUnresolvedConfigHandler` runs first (return a `Response` to fail closed), then the last-known-good config for the request's _host_ is served (never another host's), and if neither is available the new `ConfigUnresolvableError` propagates.

## 1.4.3

### Patch Changes

- [#24](https://github.com/MonetizationOS/mos-proxy/pull/24) [`4f85379`](https://github.com/MonetizationOS/mos-proxy/commit/4f85379558014fd696856f0039d6b81c3df65799) Thanks [@filipe-boleto](https://github.com/filipe-boleto)! - Add `surfaceDecisionsCookies` config to forward selected request cookies in the surface-decisions `http` payload.

  Configure comma-separated regex patterns (same style as `surfaceDecisionsIgnorePaths`) to match cookie names. Matching cookies from the incoming `Cookie` header and the origin `Set-Cookie` headers are sent as `http.cookies`. Origin values win when the same name appears in both. When unset or when no cookies match, `http.cookies` is omitted.

## 1.4.2

### Patch Changes

- [#22](https://github.com/MonetizationOS/mos-proxy/pull/22) [`42706a0`](https://github.com/MonetizationOS/mos-proxy/commit/42706a0491177b13a100555e3ee66a693fb1a28c) Thanks [@filipe-boleto](https://github.com/filipe-boleto)! - Include Referer header in surface decisions http payload

## 1.4.1

### Patch Changes

- [#20](https://github.com/MonetizationOS/mos-proxy/pull/20) [`029cb36`](https://github.com/MonetizationOS/mos-proxy/commit/029cb367889e89d9d20808cc71b5732b7c47ce44) Thanks [@JFL110](https://github.com/JFL110)! - Fix identity handling for authenticated APIs

## 1.4.0

### Minor Changes

- [#18](https://github.com/MonetizationOS/mos-proxy/pull/18) [`e5cbd90`](https://github.com/MonetizationOS/mos-proxy/commit/e5cbd909d037bc12dcbc500f4e404e573406cb53) Thanks [@benney](https://github.com/benney)! - Add `ResourceProvider` adapter for overriding the resource object sent to the
  surface-decisions API.

  Register via `MOSProxyBuilder.withResourceProvider(provider)` to supply extra
  per-request resource fields. The proxy derives defaults (`{ id: pathname, meta:
pageMetadata }`) and shallow-merges the provider's output over them, so return
  only the keys you want to add or override — `id`/`meta` are preserved unless you
  set them. Merging is shallow, matching `ClientMetadataProvider`.

  New public exports: `ResourceProvider` and `Resource`.

  With no provider configured, behaviour is identical to previous versions.

## 1.3.0

### Minor Changes

- [#15](https://github.com/MonetizationOS/mos-proxy/pull/15) [`8e1bc0a`](https://github.com/MonetizationOS/mos-proxy/commit/8e1bc0a6e5eb88117cf3758319d0a24003295b9a) Thanks [@JFL110](https://github.com/JFL110)! - Add ability to call MonetizationOS API endpoints with forwarded identity

## 1.2.0

### Minor Changes

- [#13](https://github.com/MonetizationOS/mos-proxy/pull/13) [`0dd3dcb`](https://github.com/MonetizationOS/mos-proxy/commit/0dd3dcb94409823a1540a925cf2926705ce194c4) Thanks [@benney](https://github.com/benney)! - Add `IdentityProvider` adapter for overriding identity provision (MD-1820).

  Register via `MOSProxyBuilder.withIdentityProvider(provider)` to override the
  default cookie-based identity resolution and/or the anonymous-session cookie
  write-back. Both `resolve` and `persist` are independently optional; omitted
  methods use the built-in defaults so consumers can swap just one side. A
  throwing `resolve` skips surface decisions and returns the origin response;
  a throwing `persist` keeps the pre-persist response.

  New public exports: `IdentityProvider`, `Identity`, `ResolveIdentityArgs`,
  `PersistIdentityArgs`, `getExistingCookies`, `buildIdentity`,
  `defaultResolveIdentity`, `defaultPersistIdentity`, and `MOSConfig` (the
  normalized config type, previously internal).

  With no provider configured, behaviour is identical to previous versions.

## 1.1.0

### Minor Changes

- [#12](https://github.com/MonetizationOS/mos-proxy/pull/12) [`10d3220`](https://github.com/MonetizationOS/mos-proxy/commit/10d322019b6cf0ee995bcda549b6536fbc701e9c) Thanks [@filipe-boleto](https://github.com/filipe-boleto)! - Add `createAnonymousIdentifierFallback` config option for JWT surface-decision requests.

  When enabled (the default), JWT identity payloads include `createAnonymousIdentifierFallback: true`
  so MonetizationOS can mint an anonymous identifier if JWT authentication fails. Set
  `createAnonymousIdentifierFallback: false` to opt out.

## 1.0.3

### Patch Changes

- [#7](https://github.com/MonetizationOS/mos-proxy/pull/7) [`5af7b90`](https://github.com/MonetizationOS/mos-proxy/commit/5af7b9089737209640f8de74591189882e5ae186) Thanks [@benney](https://github.com/benney)! - Link rewriting improvements via compiled regex reuse

## 1.0.2

### Patch Changes

- [#6](https://github.com/MonetizationOS/mos-proxy/pull/6) [`b010a7d`](https://github.com/MonetizationOS/mos-proxy/commit/b010a7de017ae7b9542df5ed4c72a2dc6bb51904) Thanks [@benney](https://github.com/benney)! - Add client runtime information to MOS proxy requests

## 1.0.1

### Patch Changes

- [#4](https://github.com/MonetizationOS/mos-proxy/pull/4) [`f55fbfa`](https://github.com/MonetizationOS/mos-proxy/commit/f55fbfa80ecc5abaf72dd1032e874fb8e372fae4) Thanks [@benney](https://github.com/benney)! - Fix incorrect API shape for clientMetadata
