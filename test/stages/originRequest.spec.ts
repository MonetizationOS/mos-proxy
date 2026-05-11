import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import performOriginRequest from '../../src/stages/originRequest'
import { MockFetcher } from '../fakes/MockFetcher'

const silentLogger: MOSProxyLogger = { log() {} }

const ctx = (originRequestHeaders: Record<string, string> = {}): PipelineContext => ({
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon-session',
        authenticatedUserJwtCookieName: '__session',
        originRequestHeaders,
    }),
    logger: silentLogger,
})

describe('performOriginRequest', () => {
    it('forwards requests to the configured origin URL', async () => {
        const fetcher = MockFetcher(() => new Response('ok'))

        await performOriginRequest(ctx(), new Request('https://proxy.example.com/page.json?x=1'), fetcher)

        expect(fetcher.calls[0]?.request.url).toBe('https://origin.example.com/page.json?x=1')
    })

    it('adds origin request headers to the upstream request', async () => {
        const fetcher = MockFetcher(() => new Response('ok'))

        await performOriginRequest(
            ctx({ 'X-Api-Key': 'secret', 'X-Custom': 'foo' }),
            new Request('https://proxy.example.com/page.json'),
            fetcher,
        )

        const headers = fetcher.calls[0]!.request.headers
        expect(headers.get('x-api-key')).toBe('secret')
        expect(headers.get('x-custom')).toBe('foo')
    })

    it('overrides matching client headers and preserves unrelated client headers', async () => {
        const fetcher = MockFetcher(() => new Response('ok'))

        await performOriginRequest(
            ctx({ 'X-Override': 'from-config', 'X-Extra': 'added' }),
            new Request('https://proxy.example.com/page.json', {
                headers: { 'X-Override': 'from-client', 'X-Keep': 'client-value' },
            }),
            fetcher,
        )

        const headers = fetcher.calls[0]!.request.headers
        expect(headers.get('x-override')).toBe('from-config')
        expect(headers.get('x-extra')).toBe('added')
        expect(headers.get('x-keep')).toBe('client-value')
    })

    it('preserves method and body while adding origin request headers', async () => {
        const fetcher = MockFetcher(async (request) => {
            expect(request.method).toBe('POST')
            expect(await request.clone().text()).toBe('payload')
            return new Response('ok')
        })

        await performOriginRequest(
            ctx({ 'X-Api-Key': 'secret' }),
            new Request('https://proxy.example.com/api/submit', { method: 'POST', body: 'payload' }),
            fetcher,
        )

        expect(fetcher.calls[0]?.request.headers.get('x-api-key')).toBe('secret')
    })
})
