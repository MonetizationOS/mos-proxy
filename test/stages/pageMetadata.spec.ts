import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import type { MOSProxyLogger } from '../../src/logger'
import { parsePageMetadata } from '../../src/stages/pageMetadata'
import { LolHtmlRewriter } from '../fakes/LolHtmlRewriter'

const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
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

describe('parsePageMetadata', () => {
    it('extracts meta tags keyed by name or property', async () => {
        const rewriter = new LolHtmlRewriter()
        const response = html(`
            <html><head>
                <meta name="description" content="A short description">
                <meta property="og:title" content="The Title">
                <meta name="robots" content="index,follow">
            </head><body></body></html>
        `)

        const metadata = await parsePageMetadata(ctx, response, rewriter)

        expect(metadata).toEqual({
            description: 'A short description',
            'og:title': 'The Title',
            robots: 'index,follow',
        })
    })

    it('prefers name over property when both are present', async () => {
        const rewriter = new LolHtmlRewriter()
        const response = html(`<head><meta name="author" property="og:author" content="Ada"></head>`)

        const metadata = await parsePageMetadata(ctx, response, rewriter)

        expect(metadata).toEqual({ author: 'Ada' })
    })

    it('ignores meta tags without a key or without content', async () => {
        const rewriter = new LolHtmlRewriter()
        const response = html(`
            <head>
                <meta content="orphan">
                <meta name="keywords">
                <meta charset="utf-8">
            </head>
        `)

        const metadata = await parsePageMetadata(ctx, response, rewriter)

        expect(metadata).toEqual({})
    })

    it('returns the accumulated metadata even when a downstream handler throws', async () => {
        // Wrap each registered handler so that the second `element` invocation throws. Matches
        // Cloudflare HTMLRewriter semantics: handler side effects from before the error stay
        // applied; the stage catches the resulting rejection so the outer pipeline keeps going.
        class BrokenRewriter extends LolHtmlRewriter {
            override create() {
                const session = super.create()
                const originalOn = session.on.bind(session)
                session.on = (selector, handlers) => {
                    let calls = 0
                    return originalOn(selector, {
                        ...handlers,
                        element(element) {
                            calls++
                            if (calls >= 2) throw new Error('boom')
                            handlers.element?.(element)
                        },
                    })
                }
                return session
            }
        }

        const metadata = await parsePageMetadata(
            ctx,
            html(`<head><meta name="x" content="y"><meta name="z" content="w"></head>`),
            new BrokenRewriter(),
        )

        expect(metadata).toEqual({ x: 'y' })
    })
})
