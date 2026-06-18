import { consoleLogger, type MOSProxyLogCode, type MOSProxyLogger } from './logger'
import type { MOSConfigInput } from './types'

const DEFAULT_ENDPOINTS_PREFIX = '/mos-endpoints/'

function parseCommaSeparatedRegexPatterns(
    value: string | undefined,
    invalidPatternCode: MOSProxyLogCode,
    invalidPatternMessage: (pattern: string) => string,
    logger: MOSProxyLogger,
): RegExp[] {
    const patterns: RegExp[] = []
    if (!value) {
        return patterns
    }

    for (const raw of value.split(',')) {
        const pattern = raw.trim()
        if (!pattern) continue
        try {
            patterns.push(new RegExp(pattern))
        } catch (error) {
            logger.log({
                level: 'warn',
                code: invalidPatternCode,
                message: invalidPatternMessage(pattern),
                context: { pattern },
                error,
            })
        }
    }

    return patterns
}

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
    surfaceDecisionsCookiePatterns: RegExp[]
    originRequestHeaders: Record<string, string>
    createAnonymousIdentifierFallback: boolean
}

export function normalizeMOSConfig(config: MOSConfigInput, logger: MOSProxyLogger = consoleLogger): MOSConfig {
    const ignorePathPatterns = parseCommaSeparatedRegexPatterns(
        config.surfaceDecisionsIgnorePaths,
        'invalid-ignore-path-pattern',
        (pattern) => `Invalid surfaceDecisionsIgnorePaths regex pattern: ${pattern}`,
        logger,
    )
    const cookiePatterns = parseCommaSeparatedRegexPatterns(
        config.surfaceDecisionsCookies,
        'invalid-surface-decisions-cookie-pattern',
        (pattern) => `Invalid surfaceDecisionsCookies regex pattern: ${pattern}`,
        logger,
    )

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
        surfaceDecisionsCookiePatterns: cookiePatterns,
        originRequestHeaders: { ...(config.originRequestHeaders ?? {}) },
        createAnonymousIdentifierFallback: config.createAnonymousIdentifierFallback !== false,
    }
}
