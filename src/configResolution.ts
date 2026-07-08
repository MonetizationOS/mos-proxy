import type { ConfigFactory, UnresolvedConfigHandler } from './adapters/ConfigFactory'
import { type MOSConfig, normalizeMOSConfig } from './config'
import type { MOSProxyLogger } from './logger'
import type { MOSConfigInput } from './types'

export interface ConfigResolutionOptions {
    /** Either a static config (normalized once) or a per-request factory returning a full config. */
    input: MOSConfigInput | ConfigFactory
    onUnresolved: UnresolvedConfigHandler | null
    maxCachedConfigs: number
    logger: MOSProxyLogger
}

/** Thrown when no config could be resolved for a request and the host has no last-known-good fallback. */
export class ConfigUnresolvableError extends Error {
    constructor(
        readonly host: string,
        options?: { cause?: unknown },
    ) {
        super(`MOSProxy: could not resolve a config for host "${host}" and no last-known-good config is available`, options)
        this.name = 'ConfigUnresolvableError'
    }
}

// Discriminated union so resolve() can switch on kind without null checks or casts.
type ConfigSource = { readonly kind: 'static'; readonly config: MOSConfig } | { readonly kind: 'factory'; readonly factory: ConfigFactory }

// Negative-cache marker: holds the error so cache hits report the same cause as the first failure.
class FailedNormalization {
    constructor(readonly error: unknown) {}
}

/**
 * Resolves the config for a request. A static config is normalized once up front. A factory runs per
 * request and its result is normalized and cached by content. If the factory throws or its config
 * won't normalize, we fall back to the handler, then the host's last-known-good config, then throw.
 */
export class ConfigResolution {
    private readonly source: ConfigSource
    private readonly onUnresolved: UnresolvedConfigHandler | null
    private readonly maxCachedConfigs: number
    private readonly logger: MOSProxyLogger
    // Normalized configs keyed by content. A FailedNormalization marks a config that failed to normalize.
    private readonly cache = new Map<string, MOSConfig | FailedNormalization>()
    // Last config that normalized for each host. Keyed by host so a brand never falls back to another's.
    private readonly lastGoodByHost = new Map<string, MOSConfig>()

    constructor(opts: ConfigResolutionOptions) {
        if (!Number.isInteger(opts.maxCachedConfigs) || opts.maxCachedConfigs < 1) {
            throw new RangeError(`MOSProxy: maxCachedConfigs must be a positive integer (got ${opts.maxCachedConfigs})`)
        }
        this.onUnresolved = opts.onUnresolved
        this.maxCachedConfigs = opts.maxCachedConfigs
        this.logger = opts.logger
        this.source =
            typeof opts.input === 'function'
                ? { kind: 'factory', factory: opts.input }
                : { kind: 'static', config: normalizeMOSConfig(opts.input, opts.logger) }
    }

    async resolve(request: Request): Promise<MOSConfig | Response> {
        const source = this.source
        if (source.kind === 'static') {
            return source.config
        }

        const host = new URL(request.url).hostname

        let input: MOSConfigInput
        try {
            input = await source.factory(request)
        } catch (error) {
            // Log every time: a throwing factory has no config to dedupe against.
            this.logFailure('Config factory threw.', error)
            return this.failOver(request, host, error)
        }

        const key = JSON.stringify(input)

        const cached = this.cache.get(key)
        if (cached !== undefined) {
            this.touch(this.cache, key, cached) // bump to newest on hit so hot configs outlive cold ones
            if (cached instanceof FailedNormalization) {
                return this.failOver(request, host, cached.error)
            }
            this.rememberGood(host, cached)
            return cached
        }

        let normalized: MOSConfig
        try {
            normalized = normalizeMOSConfig(input, this.logger)
        } catch (error) {
            this.remember(key, new FailedNormalization(error))
            this.logFailure('Resolved config failed to normalize.', error)
            return this.failOver(request, host, error)
        }

        this.remember(key, normalized)
        this.rememberGood(host, normalized)
        return normalized
    }

    private remember(key: string, value: MOSConfig | FailedNormalization): void {
        this.touch(this.cache, key, value)
    }

    private rememberGood(host: string, config: MOSConfig): void {
        this.touch(this.lastGoodByHost, host, config)
    }

    // Add or move key to newest, then drop the oldest entry if we're over the cap (LRU).
    private touch<V>(map: Map<string, V>, key: string, value: V): void {
        map.delete(key)
        map.set(key, value)
        if (map.size > this.maxCachedConfigs) {
            const oldest = map.keys().next().value
            if (oldest !== undefined) {
                map.delete(oldest)
            }
        }
    }

    private logFailure(message: string, error: unknown): void {
        this.logger.log({ level: 'error', code: 'config-resolution-failed', message, error })
    }

    private async failOver(request: Request, host: string, error?: unknown): Promise<MOSConfig | Response> {
        const handler = this.onUnresolved
        if (handler) {
            try {
                const response = await handler({ request, reason: 'invalid-config', error })
                if (response instanceof Response) {
                    return response
                }
                // Nothing means "use last-known-good". Anything that isn't a Response is a handler bug.
                if (response != null) {
                    this.logger.log({
                        level: 'warn',
                        code: 'unresolved-config-handler-invalid',
                        message: 'onUnresolvedConfig did not return a Response; falling back to the last-known-good config.',
                        context: { host },
                    })
                }
            } catch (handlerError) {
                this.logger.log({
                    level: 'warn',
                    code: 'unresolved-config-handler-threw',
                    message: 'onUnresolvedConfig threw; falling back to the last-known-good config.',
                    context: { host },
                    error: handlerError,
                })
            }
        }

        const lastGood = this.lastGoodByHost.get(host)
        if (lastGood) {
            this.logger.log({
                level: 'warn',
                code: 'config-resolution-served-last-known-good',
                message: 'Serving the last-known-good config for this host after a resolution failure.',
                context: { host },
            })
            return lastGood
        }

        throw new ConfigUnresolvableError(host, { cause: error })
    }
}
