# Copilot instructions for mos-proxy

Trust these instructions. Search the repo only when something here is missing, stale, or ambiguous.

## Project overview

`@monetizationos/proxy` is the platform-agnostic core of the MonetizationOS proxy. It is a small, strict TypeScript, ESM-only library: input is a Fetch API `Request`, output is a `Response`, and consumers provide runtime adapters for fetch, HTML rewriting, and client metadata.

- Runtime: Node `>=22`, TypeScript targeting `esnext`, package `"type": "module"`.
- Package manager: pnpm `10.32.1`, pinned in `package.json`. Do not use npm or yarn.
- This is not a monorepo, even though `pnpm-workspace.yaml` exists; that file only holds pnpm settings.
- Public API surface is whatever `src/index.ts` re-exports. Treat changes there as semver-significant.

## Required commands

Use this order when reproducing CI or validating changes:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
```

Notes:

- `pnpm test` starts watch mode; use `pnpm test:run` in agents and CI.
- `pnpm typecheck` covers `src/**/*.ts` and `test/**/*.ts`; `pnpm build` emits only `src/` to `dist/`.
- If lint fails, run `pnpm format`, then rerun `pnpm lint`.
- Do not commit `dist/`, `node_modules/`, `coverage/`, or lockfile changes unless dependencies changed.

## Source map

- `src/index.ts` is the public barrel.
- `src/MOSProxy.ts` orchestrates request handling.
- `src/MOSProxyBuilder.ts` is the primary fluent public entry point.
- `src/adapters/` defines consumer-implemented runtime interfaces.
- `src/stages/` contains one file per pipeline stage plus stage helpers.
- `test/fakes/` contains reusable in-memory adapters; prefer these over new mocks.

Pipeline order:

1. Custom endpoint routing (`/mos-endpoints/*` to MOS API)
2. Origin fetch
3. Link rewriting
4. Surface decisions (includes `<meta>` extraction via `parsePageMetadata`, only when surface decisions and an HTML rewriter adapter are both configured)
5. Surface behavior HTTP mutations
6. Surface components DOM transforms

Stages 3-6 are HTML-only and auto-skip otherwise. `.withoutHtmlTransformation()` disables them entirely. The HTML pipeline fails open by default by logging and returning the last safe response; `.withHtmlPipelineErrorHandler(...)` can override this.

## Conventions

- Keep `src/` runtime code edge-safe: no Node-only APIs such as `fs`, `path`, `process`, or `Buffer`. This applies to executable code; JSDoc examples may reference consumer-side patterns like `process.env`.
- Use ESM `import`/`export`; no `require`.
- Follow Biome formatting: 4-space indent, single quotes, no semicolons, trailing commas, LF line endings.
- `nursery.noFloatingPromises` is an error; always `await` promises or mark them with `void`.
- `noUncheckedIndexedAccess` is enabled; narrow indexed values before use.
- Tests must be named `*.spec.ts`; Vitest includes `test/**/*.spec.ts`.

## Release and versioning gotchas

- User-facing changes in `src/` need a Changeset: run `pnpm changeset` and commit the generated `.changeset/*.md`.
- Package version is duplicated in `src/apiRequestHeaders.ts` as `MOS_PROXY_PACKAGE_VERSION`. If manually bumping `package.json`, also update that constant or run `node scripts/sync-version.mjs && pnpm format`.
- `prepublishOnly` runs `typecheck && test:run && build`; do not bypass it.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`, so very recent dependency versions may be rejected during install. Choose an older version instead of disabling the setting.
