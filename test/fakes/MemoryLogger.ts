import type { MOSProxyLogEvent } from '../../src/logger'

/**
 * Fake logger that captures emitted events for assertions. Returns the captured `events` array
 * alongside the `logger` to pass into the proxy.
 */
export function createMemoryLogger() {
    const events: MOSProxyLogEvent[] = []
    return {
        events,
        logger: {
            log(event: MOSProxyLogEvent) {
                events.push(event)
            },
        },
    }
}
