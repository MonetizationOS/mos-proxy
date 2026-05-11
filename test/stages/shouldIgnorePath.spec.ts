import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import shouldIgnorePath from '../../src/stages/shouldIgnorePath'
import type { MOSConfigInput } from '../../src/types'

const rawBaseConfig: MOSConfigInput = {
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test_abc',
    anonymousSessionCookieName: 'anon',
    authenticatedUserJwtCookieName: 'jwt',
}

const silentLogger: MOSProxyLogger = { log() {} }
const ctx = (overrides: Partial<MOSConfigInput> = {}): PipelineContext => ({
    config: normalizeMOSConfig({ ...rawBaseConfig, ...overrides }, silentLogger),
    logger: silentLogger,
})

const makeRequest = (path: string) => new Request(`https://proxy.example.com${path}`)

describe('shouldIgnorePath', () => {
    it('returns false when no patterns are configured', () => {
        expect(shouldIgnorePath(ctx(), makeRequest('/page'))).toBe(false)
    })

    it('returns true when path matches a single pattern', () => {
        const c = ctx({ surfaceDecisionsIgnorePaths: '^/health' })
        expect(shouldIgnorePath(c, makeRequest('/health'))).toBe(true)
        expect(shouldIgnorePath(c, makeRequest('/health/live'))).toBe(true)
    })

    it('returns false when path does not match any pattern', () => {
        const c = ctx({ surfaceDecisionsIgnorePaths: '^/health,^/static' })
        expect(shouldIgnorePath(c, makeRequest('/article'))).toBe(false)
    })

    it('ignores empty pattern entries caused by trailing commas', () => {
        const c = ctx({ surfaceDecisionsIgnorePaths: ',^/health,' })
        expect(shouldIgnorePath(c, makeRequest('/health'))).toBe(true)
        expect(shouldIgnorePath(c, makeRequest('/article'))).toBe(false)
    })

    it('swallows invalid regex patterns without crashing', () => {
        const c = ctx({ surfaceDecisionsIgnorePaths: '[invalid,^/ok' })
        expect(shouldIgnorePath(c, makeRequest('/ok'))).toBe(true)
    })
})
