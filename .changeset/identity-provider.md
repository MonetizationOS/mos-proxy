---
'@monetizationos/proxy': minor
---

Add `IdentityProvider` adapter for overriding identity provision (MD-1820).

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
