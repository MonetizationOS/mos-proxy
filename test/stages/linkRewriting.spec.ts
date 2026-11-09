import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import rewriteOriginResponse from '../../src/stages/linkRewriting'
import compileOriginLinkRewriter from '../../src/stages/originLinkRewriter'
import { controlledStream } from '../fakes/ControlledStream'

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

    describe('streaming', () => {
        const page = [
            '\uFEFF<html><head><link rel="canonical" href="https://origin.example.com/a">',
            '<script src="//origin.example.com/s.js"></script></head><body>',
            '<a href="http://origin.example.com">x</a> https://origin.example.com.evil/ //origin.example.comx',
            ' café 😀 https://origin.example.com/😀 ',
            '<a href="https://origin.example.com/b">y</a></body></html>',
        ].join('')
        const bytes = new TextEncoder().encode(page)
        // What the old whole-body path produced: `response.text()` (drops the BOM), then one rewrite.
        const expected = compileOriginLinkRewriter(
            new URL('https://proxy.example.com/'),
            new URL('https://origin.example.com'),
        )(new TextDecoder().decode(bytes))

        const rewriteChunks = async (chunks: Uint8Array[]) => {
            const source = controlledStream()
            source.push(...chunks)
            source.close()
            const result = await rewriteOriginResponse(
                ctx,
                proxyRequest(),
                new Response(source.stream, { headers: { 'Content-Type': 'text/html' } }),
            )
            return await result.text()
        }

        it('matches the whole-body rewrite for every split point', async () => {
            for (let i = 0; i <= bytes.length; i++) {
                expect(await rewriteChunks([bytes.slice(0, i), bytes.slice(i)])).toBe(expected)
            }
        })

        it('matches the whole-body rewrite when fed byte by byte', async () => {
            expect(await rewriteChunks(Array.from(bytes, (byte) => Uint8Array.of(byte)))).toBe(expected)
        })

        it('returns before the origin body ends', async () => {
            const source = controlledStream()
            source.push(`<head>${'<link href="https://origin.example.com/x">'.repeat(10)}</head>`)
            const result = await rewriteOriginResponse(
                ctx,
                proxyRequest(),
                new Response(source.stream, { headers: { 'Content-Type': 'text/html' } }),
            )

            const reader = result.body!.getReader()
            const { value } = await reader.read()
            expect(new TextDecoder().decode(value)).toContain('<head><link href="https://proxy.example.com/x">')
            await reader.cancel()
            expect(source.cancelled).toBe(true)
        })

        it('cancels the origin while a read is waiting on it', async () => {
            const source = controlledStream()
            source.push('<head></head>')
            const result = await rewriteOriginResponse(
                ctx,
                proxyRequest(),
                new Response(source.stream, { headers: { 'Content-Type': 'text/html' } }),
            )

            const reader = result.body!.getReader()
            await reader.read()
            const pending = reader.read()
            // Let the pull reach the stalled origin read
            await new Promise((resolve) => setTimeout(resolve, 0))
            await reader.cancel()

            expect(source.cancelled).toBe(true)
            expect((await pending).done).toBe(true)
        })

        it('holds back only text that could still become an origin link', async () => {
            const source = controlledStream()
            source.push('<head></head><body>')
            const result = await rewriteOriginResponse(
                ctx,
                proxyRequest(),
                new Response(source.stream, { headers: { 'Content-Type': 'text/html' } }),
            )
            const reader = result.body!.getReader()
            const decoder = new TextDecoder()

            expect(decoder.decode((await reader.read()).value)).toBe('<head></head><body>')
            source.push('<a href="https://origin.exam')
            expect(decoder.decode((await reader.read()).value)).toBe('<a href="')
            source.push('ple.com/x">')
            source.close()
            expect(decoder.decode((await reader.read()).value)).toBe('https://proxy.example.com/x">')
        })

        it('returns a null body for an empty origin body', async () => {
            const result = await rewriteChunks([])
            expect(result).toBe('')
            const empty = await rewriteOriginResponse(
                ctx,
                proxyRequest(),
                new Response(new Uint8Array(0), { headers: { 'Content-Type': 'text/html' } }),
            )
            expect(empty.body).toBeNull()
        })
    })
})
