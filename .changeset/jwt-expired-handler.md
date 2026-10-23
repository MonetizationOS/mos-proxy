---
"@monetizationos/proxy": minor
---

Handle expired authenticated-user JWTs reported by MonetizationOS. Top-level navigations ask the API to short-circuit (`identity.jwtExpiredHandling: 'shortCircuit'`), and a `jwt_expired` error carrying `http` becomes the reply (typically a 307 to the re-auth URL) with `Cache-Control: no-store` and a 30-second `mos-jwt-refresh` loop guard. JWT identities also send the visitor's existing `anonymousIdentifier` so the anonymous fallback reuses it. Add `MOSProxyBuilder.withJwtExpiredHandler` to override that reply. The proxy never decodes JWTs.
