import type { MOSConfigInput } from '../types'

/**
 * Returns a complete `MOSConfigInput` for a request. Throw when there's no config; the proxy then
 * calls the {@link UnresolvedConfigHandler}, falls back to the host's last-known-good config, or rethrows.
 *
 * Runs on every request. The proxy caches only the normalize step (by config content), not the call,
 * so cache an expensive lookup like KV yourself if the per-request read is an issue.
 */
export type ConfigFactory = (request: Request) => MOSConfigInput | Promise<MOSConfigInput>

/** Why per-request config resolution did not produce a usable config. */
export type UnresolvedConfigReason = 'invalid-config'

/** Context passed to an {@link UnresolvedConfigHandler}. */
export interface UnresolvedConfigContext {
    request: Request
    /** `invalid-config`: the factory threw, or its config failed to normalize. */
    reason: UnresolvedConfigReason
    /** The error that caused resolution to fail. */
    error?: unknown
}

/**
 * Handles a request whose config couldn't be resolved. Return a `Response` to fail closed (e.g. a 404
 * for an unknown host), or return nothing to fall through to the host's last-known-good config. If
 * neither is available, the error propagates. A handler that throws or returns a non-`Response` is
 * logged and treated as if it returned nothing.
 */
export type UnresolvedConfigHandler = (ctx: UnresolvedConfigContext) => Response | undefined | Promise<Response | undefined>
