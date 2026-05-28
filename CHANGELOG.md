# @monetizationos/proxy

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
