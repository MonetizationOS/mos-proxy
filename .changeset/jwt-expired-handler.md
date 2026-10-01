---
"@monetizationos/proxy": minor
---

Add `MOSProxyBuilder.withJwtExpiredHandler` so a proxy can react when the authenticated-user JWT cookie is past `exp`. Return a `Response` to refresh or redirect, or return nothing to keep proxying.
