export type MOSProxyLogLevel = 'warn' | 'error'

export type MOSProxyLogCode =
    | 'html-pipeline-failed'
    | 'html-pipeline-error-handler-invalid'
    | 'html-pipeline-error-handler-threw'
    | 'invalid-ignore-path-pattern'
    | 'response-clone-failed'
    | 'surface-decisions-api-failed'
    | 'identity-resolve-failed'
    | 'identity-persist-failed'
    | 'link-rewriting-header-failed'
    | 'link-rewriting-body-failed'
    | 'marker-pass-invalid-state'
    | 'marker-pass-selector-failed'
    | 'replacement-markers-identical'
    | 'replacement-state-missing'
    | 'element-render-failed'
    | 'element-type-unsupported'
    | 'page-metadata-parse-failed'
    | 'component-selector-unsupported'
    | 'component-range-replacement-skipped'
    | 'component-transform-failed'

export interface MOSProxyLogEvent {
    level: MOSProxyLogLevel
    code: MOSProxyLogCode
    message: string
    context?: Record<string, unknown>
    error?: unknown
}

export interface MOSProxyLogger {
    log(event: MOSProxyLogEvent): void
}

export const consoleLogger: MOSProxyLogger = {
    log(event) {
        const details: unknown[] = [event.message, { code: event.code, ...event.context }]
        if (event.error) {
            details.push(event.error)
        }

        if (event.level === 'error') {
            console.error(...details)
            return
        }

        console.warn(...details)
    },
}
