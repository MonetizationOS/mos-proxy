import { consoleLogger, type MOSProxyLogger } from './logger'
import type { MOSConfigInput } from './types'

const DEFAULT_ENDPOINTS_PREFIX = '/mos-endpoints/'

export interface MOSConfig {
    originUrl: URL
    surfaceSlug: string
    mosHost: URL
    mosSecretKey: string
    mosEnvironment: string
    mosEndpointsPrefix: string
    anonymousSessionCookieName: string
    authenticatedUserJwtCookieName: string
    injectScriptUrl: string | undefined
    surfaceDecisionsIgnorePathPatterns: RegExp[]
    originRequestHeaders: Record<string, string>
    createAnonymousIdentifierFallback: boolean
}

export function normalizeMOSConfig(config: MOSConfigInput, logger: MOSProxyLogger = consoleLogger): MOSConfig {
    const ignorePathPatterns: RegExp[] = []
    if (config.surfaceDecisionsIgnorePaths) {
        for (const raw of config.surfaceDecisionsIgnorePaths.split(',')) {
            const pattern = raw.trim()
            if (!pattern) continue
            try {
                ignorePathPatterns.push(new RegExp(pattern))
            } catch (error) {
                logger.log({
                    level: 'warn',
                    code: 'invalid-ignore-path-pattern',
                    message: `Invalid surfaceDecisionsIgnorePaths regex pattern: ${pattern}`,
                    context: { pattern },
                    error,
                })
            }
        }
    }

    const secretKeyParts = config.mosSecretKey.split('_')

    return {
        originUrl: new URL(config.originUrl),
        surfaceSlug: config.surfaceSlug,
        mosHost: new URL(config.mosHost),
        mosSecretKey: config.mosSecretKey,
        mosEnvironment: `${secretKeyParts[1] ?? ''}_${secretKeyParts[2] ?? ''}`,
        mosEndpointsPrefix: config.mosEndpointsPrefix || DEFAULT_ENDPOINTS_PREFIX,
        anonymousSessionCookieName: config.anonymousSessionCookieName,
        authenticatedUserJwtCookieName: config.authenticatedUserJwtCookieName,
        injectScriptUrl: config.injectScriptUrl,
        surfaceDecisionsIgnorePathPatterns: ignorePathPatterns,
        originRequestHeaders: { ...(config.originRequestHeaders ?? {}) },
        createAnonymousIdentifierFallback: config.createAnonymousIdentifierFallback !== false,
    }
}
