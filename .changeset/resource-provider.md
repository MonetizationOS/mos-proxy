---
'@monetizationos/proxy': minor
---

Add `ResourceProvider` adapter for overriding the resource object sent to the
surface-decisions API.

Register via `MOSProxyBuilder.withResourceProvider(provider)` to supply extra
per-request resource fields. The proxy derives defaults (`{ id: pathname, meta:
pageMetadata }`) and shallow-merges the provider's output over them, so return
only the keys you want to add or override — `id`/`meta` are preserved unless you
set them. Merging is shallow, matching `ClientMetadataProvider`.

New public exports: `ResourceProvider` and `Resource`.

With no provider configured, behaviour is identical to previous versions.
