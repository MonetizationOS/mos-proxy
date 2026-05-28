---
'@monetizationos/proxy': minor
---

Add `createAnonymousIdentifierFallback` config option for JWT surface-decision requests.

When enabled (the default), JWT identity payloads include `createAnonymousIdentifierFallback: true`
so MonetizationOS can mint an anonymous identifier if JWT authentication fails. Set
`createAnonymousIdentifierFallback: false` to opt out.
