---
'@monetizationos/proxy': patch
---

Add `MOSProxyBuilder.withClientIP((request) => ...)` so each CDN runtime supplies the end-user IP for MOS API requests as `http.clientIP`. Applies to surface-decisions and authenticated `/mos-api/*` routes.
