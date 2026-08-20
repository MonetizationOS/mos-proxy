import { describe, expect, it, vi } from 'vitest'
import type { ClientMetadataProvider, IdentityProvider } from '../../src'
import { MOS_PROXY_CLIENT_HEADER, MOS_PROXY_PACKAGE_VERSION, MOS_PROXY_VERSION_HEADER } from '../../src/apiRequestHeaders'
import { type MOSConfig, normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import customEndpointRequest from '../../src/stages/customEndpoint'
import type { MOSConfigInput } from '../../src/types'
import { MockFetcher } from '../fakes/MockFetcher'

const rawBaseConfig: MOSConfigInput = {
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test_abc',
    mosEndpointsPrefix: '/mos-endpoints/',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
}
const silentLogger: MOSProxyLogger = { log() {} }
const ctx = (config: MOSConfig): PipelineContext => ({ config, logger: silentLogger })
const baseConfig = normalizeMOSConfig(rawBaseConfig)
const clientMetadataProvider: ClientMetadataProvider = { build: vi.fn() }
const identityProvider: IdentityProvider = { resolve: vi.fn() }

describe('customEndpointRequest', () => {
    it('returns null for paths outside the prefix', async () => {
        const fetcher = MockFetcher(() => new Response('should not be called', { status: 500 }))
        const result = await customEndpointRequest(
            ctx(baseConfig),
            new Request('https://proxy.example.com/other/thing'),
            identityProvider,
            clientMetadataProvider,
            fetcher,
        )
        expect(result).toBeNull()
        expect(fetcher.calls.length).toBe(0)
    })

    it('rewrites the request URL onto the MOS API host using the env extracted from the secret key', async () => {
        const fetcher = MockFetcher((req) => new Response(`got ${req.url}`, { status: 200 }))
        vi.spyOn(clientMetadataProvider, 'build').mockReturnValue({ prop: 'value' })
        vi.spyOn(identityProvider, 'resolve').mockReturnValue({ anonymousIdentifier: 'anon_123' })

        const response = await customEndpointRequest(
            ctx(baseConfig),
            new Request('https://proxy.example.com/mos-endpoints/foo/bar?x=1', {
                method: 'POST',
                body: 'payload',
                headers: { [MOS_PROXY_VERSION_HEADER]: 'spoofed' },
            }),
            identityProvider,
            clientMetadataProvider,
            fetcher,
        )

        expect(response).not.toBeNull()
        expect(response!.status).toBe(200)
        const sent = fetcher.calls[0]!.request
        expect(sent.url).toBe('https://api.monetizationos.com/api/v1/envs/env_test/endpoints/foo/bar?x=1')
        expect(sent.method).toBe('POST')
        expect(sent.headers.get(MOS_PROXY_VERSION_HEADER)).toBe(MOS_PROXY_PACKAGE_VERSION)
        expect(sent.headers.get(MOS_PROXY_CLIENT_HEADER)).toMatch(/^runtime=/)
        expect(sent.headers.get('x-mos-key')).toBe(`PublicBearer ${rawBaseConfig.mosSecretKey}`)
        expect(sent.headers.get('x-mos-endpoint-request-context')).toBe(
            JSON.stringify({ identity: { anonymousIdentifier: 'anon_123' }, clientMetadata: { prop: 'value' } }),
        )
        expect(await sent.text()).toBe('payload')
    })

    it('falls back to the default prefix when mosEndpointsPrefix is omitted', async () => {
        const fetcher = MockFetcher((req) => new Response(null, { status: 200, headers: { 'x-target': req.url } }))
        const { mosEndpointsPrefix: _omit, ...rest } = rawBaseConfig

        const response = await customEndpointRequest(
            ctx(normalizeMOSConfig(rest)),
            new Request('https://proxy.example.com/mos-endpoints/hello'),
            null,
            null,
            fetcher,
        )

        expect(response).not.toBeNull()
        expect(response!.headers.get('x-target')).toBe('https://api.monetizationos.com/api/v1/envs/env_test/endpoints/hello')
    })

    it('preserves the API host port and protocol when mosHost specifies them', async () => {
        const fetcher = MockFetcher((req) => new Response(null, { status: 200, headers: { 'x-target': req.url } }))

        const response = await customEndpointRequest(
            ctx(normalizeMOSConfig({ ...rawBaseConfig, mosHost: 'http://api.local:8080' })),
            new Request('https://proxy.example.com/mos-endpoints/ping'),
            null,
            null,
            fetcher,
        )

        expect(response).not.toBeNull()
        expect(response!.headers.get('x-target')).toBe('http://api.local:8080/api/v1/envs/env_test/endpoints/ping')

        const sent = fetcher.calls[0]!.request
        expect(sent.headers.get('x-mos-key')).toBe(`PublicBearer ${rawBaseConfig.mosSecretKey}`)
        expect(sent.headers.get('x-mos-endpoint-request-context')).toBe(
            JSON.stringify({ identity: { createAnonymousIdentifier: true }, clientMetadata: {} }),
        )
    })

    it('handles a secret key without enough segments by producing an underscore env path', async () => {
        const fetcher = MockFetcher((req) => new Response(null, { status: 200, headers: { 'x-target': req.url } }))

        const response = await customEndpointRequest(
            ctx(normalizeMOSConfig({ ...rawBaseConfig, mosSecretKey: 'oops' })),
            new Request('https://proxy.example.com/mos-endpoints/ping'),
            identityProvider,
            clientMetadataProvider,
            fetcher,
        )

        expect(response).not.toBeNull()
        expect(response!.headers.get('x-target')).toBe('https://api.monetizationos.com/api/v1/envs/_/endpoints/ping')
    })
})
