import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import rewriteOriginResponse from '../../src/stages/linkRewriting'

const silentLogger: MOSProxyLogger = { log() {} }
const ctx: PipelineContext = {
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon',
        authenticatedUserJwtCookieName: 'jwt',
    }),
    logger: silentLogger,
}
const proxyRequest = (path = '/article') => new Request(`https://proxy.example.com${path}`)

describe('rewriteOriginResponse', () => {
    it('rewrites origin host references in the body to the proxy host', async () => {
        const response = new Response('<a href="https://origin.example.com/x">go</a>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        })

        const result = await rewriteOriginResponse(ctx, proxyRequest(), response)

        expect(await result.text()).toBe('<a href="https://proxy.example.com/x">go</a>')
        expect(result.headers.get('Cache-Control')).toBe('no-store')
    })

    it('rewrites origin host references in response headers', async () => {
        const response = new Response('', {
            status: 302,
            headers: { Location: 'https://origin.example.com/new' },
        })

        const result = await rewriteOriginResponse(ctx, proxyRequest('/old'), response)

        expect(result.headers.get('Location')).toBe('https://proxy.example.com/new')
    })

    it('returns an empty-body response for redirects without touching the origin stream', async () => {
        // Regression: previously this path called response.text() and then re-emitted the
        // (now-disturbed) origin stream, which undici rejects.
        const response = new Response('', {
            status: 302,
            headers: { Location: 'https://origin.example.com/new', 'Content-Type': 'text/html' },
        })

        const result = await rewriteOriginResponse(ctx, proxyRequest('/old'), response)

        expect(result.status).toBe(302)
        expect(result.headers.get('Location')).toBe('https://proxy.example.com/new')
        expect(await result.text()).toBe('')
    })

    it.each([204, 205, 304])('returns a null-body response for status %s', async (status) => {
        const response = new Response(null, { status })

        const result = await rewriteOriginResponse(ctx, proxyRequest(), response)

        expect(result.status).toBe(status)
        expect(result.body).toBeNull()
    })

    it('strips Content-Length and Content-Encoding when the body is mutated', async () => {
        // Origin sent compressed bytes; after we decode-and-rewrite, those headers no longer
        // describe the new payload and would mislead downstream clients.
        const response = new Response('<a href="https://origin.example.com/x">go</a>', {
            status: 200,
            headers: {
                'Content-Type': 'text/html',
                'Content-Length': '999',
                'Content-Encoding': 'gzip',
            },
        })

        const result = await rewriteOriginResponse(ctx, proxyRequest(), response)

        expect(result.headers.get('Content-Length')).toBeNull()
        expect(result.headers.get('Content-Encoding')).toBeNull()
    })

    it('preserves Content-Length and Content-Encoding on no-body statuses (body is not mutated)', async () => {
        const response = new Response(null, {
            status: 304,
            headers: { 'Content-Length': '0', 'Content-Encoding': 'gzip' },
        })

        const result = await rewriteOriginResponse(ctx, proxyRequest(), response)

        expect(result.headers.get('Content-Length')).toBe('0')
        expect(result.headers.get('Content-Encoding')).toBe('gzip')
    })
})
