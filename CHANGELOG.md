# @monetizationos/proxy

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
