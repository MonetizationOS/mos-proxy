---
"@monetizationos/proxy": patch
---

Add `surfaceDecisionsCookies` config to forward selected request cookies in the surface-decisions `http` payload.

Configure comma-separated regex patterns (same style as `surfaceDecisionsIgnorePaths`) to match cookie names. Matching cookies from the incoming `Cookie` header and the origin `Set-Cookie` headers are sent as `http.cookies`. Origin values win when the same name appears in both. When unset or when no cookies match, `http.cookies` is omitted.
