---
'@monetizationos/proxy': patch
---

Publish an ESM build Node resolves without a bundler. The emitted JavaScript and type declarations previously carried extensionless relative specifiers, so importing the package from plain Node failed with `ERR_UNSUPPORTED_DIR_IMPORT` and a consumer on `moduleResolution: NodeNext` could not resolve its types. Self-hosted Node integrations no longer need a build step.
