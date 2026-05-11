import type { MOSConfig } from './config'
import type { MOSProxyLogger } from './logger'

/**
 * Shared environment threaded into every pipeline stage that needs cross-cutting infrastructure
 * (normalized config, logger, and — when added — metrics/tracer/clock). Built once per request in
 * `MOSProxy.handle`. Stages that only operate on a response and decision payload (e.g.
 * `handleSurfaceBehavior`, `isRedirectResponse`) deliberately do not take a context.
 */
export interface PipelineContext {
    config: MOSConfig
    logger: MOSProxyLogger
}
