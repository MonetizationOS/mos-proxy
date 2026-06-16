import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../src/config'
import type { MOSProxyLogger } from '../src/logger'

describe('normalizeMOSConfig surfaceDecisionsCookies', () => {
    const baseConfig = {
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon-session',
        authenticatedUserJwtCookieName: '__session',
    }

    it('parses comma-separated cookie name patterns', () => {
        const config = normalizeMOSConfig({
            ...baseConfig,
            surfaceDecisionsCookies: '^__session$, ^mos_',
        })

        expect(config.surfaceDecisionsCookiePatterns).toHaveLength(2)
        expect(config.surfaceDecisionsCookiePatterns[0]!.test('__session')).toBe(true)
        expect(config.surfaceDecisionsCookiePatterns[1]!.test('mos_theme')).toBe(true)
    })

    it('logs and skips invalid regex patterns', () => {
        const events: unknown[] = []
        const logger: MOSProxyLogger = {
            log(event) {
                events.push(event)
            },
        }

        const config = normalizeMOSConfig(
            {
                ...baseConfig,
                surfaceDecisionsCookies: 'valid, [invalid',
            },
            logger,
        )

        expect(config.surfaceDecisionsCookiePatterns).toHaveLength(1)
        expect(events).toEqual([
            expect.objectContaining({
                code: 'invalid-surface-decisions-cookie-pattern',
            }),
        ])
    })
})
