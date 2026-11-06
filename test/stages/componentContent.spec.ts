import { describe, expect, it } from 'vitest'
import { normalizeMOSConfig } from '../../src/config'
import type { PipelineContext } from '../../src/context'
import handleSurfaceComponents from '../../src/stages/surfaceComponents'
import type { SurfaceDecisionResponse, WebContentSurfaceBehavior } from '../../src/types'
import { LolHtmlRewriter } from '../fakes/LolHtmlRewriter'

const componentsTag = `<script src="https://example.com/web-components-latest.js" async defer></script>`

const ctx: PipelineContext = {
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon-session',
        authenticatedUserJwtCookieName: '__session',
        injectScriptUrl: 'https://example.com/web-components-latest.js',
    }),
    logger: { log() {} },
}

const decisions = (componentBehaviors: SurfaceDecisionResponse['componentBehaviors']): SurfaceDecisionResponse => ({
    status: 'success',
    identity: { identifier: 'id', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: false },
    surfaceBehavior: {},
    componentsSkipped: false,
    componentBehaviors,
})

describe('component content on whole pages', () => {
    it.each([
        {
            name: 'before',
            content: { before: [{ type: 'html', content: 'BEFORE' } as const] },
            expected: `<body><head>${componentsTag}</head>BEFORE<h1>Test</h1></body>`,
        },
        {
            name: 'before multiple',
            content: {
                before: [
                    { type: 'html', content: '<p>1</p>' } as const,
                    { type: 'html', content: '<p>2</p>' } as const,
                    { type: 'html', content: '<p>3</p>' } as const,
                ],
            },
            expected: `<body><head>${componentsTag}</head><p>1</p><p>2</p><p>3</p><h1>Test</h1></body>`,
        },
        {
            name: 'after',
            content: { after: [{ type: 'html', content: 'AFTER' } as const] },
            expected: `<body><head>${componentsTag}</head><h1>Test</h1>AFTER</body>`,
        },
        {
            name: 'after multiple',
            content: {
                after: [
                    { type: 'html', content: '<p>1</p>' } as const,
                    { type: 'html', content: '<p>2</p>' } as const,
                    { type: 'html', content: '<p>3</p>' } as const,
                ],
            },
            expected: `<body><head>${componentsTag}</head><h1>Test</h1><p>1</p><p>2</p><p>3</p></body>`,
        },
        {
            name: 'prepend',
            content: { prepend: [{ type: 'html', content: '<p>PREPEND</p>' } as const] },
            expected: `<body><head>${componentsTag}</head><h1><p>PREPEND</p>Test</h1></body>`,
        },
        {
            name: 'prepend multiple',
            content: {
                prepend: [
                    { type: 'html', content: '<p>1</p>' } as const,
                    { type: 'html', content: '<p>2</p>' } as const,
                    { type: 'html', content: '<p>3</p>' } as const,
                ],
            },
            expected: `<body><head>${componentsTag}</head><h1><p>1</p><p>2</p><p>3</p>Test</h1></body>`,
        },
        {
            name: 'append',
            content: { append: [{ type: 'html', content: '<p>APPEND</p>' } as const] },
            expected: `<body><head>${componentsTag}</head><h1>Test<p>APPEND</p></h1></body>`,
        },
        {
            name: 'append multiple',
            content: {
                append: [
                    { type: 'html', content: '<p>1</p>' } as const,
                    { type: 'html', content: '<p>2</p>' } as const,
                    { type: 'html', content: '<p>3</p>' } as const,
                ],
            },
            expected: `<body><head>${componentsTag}</head><h1>Test<p>1</p><p>2</p><p>3</p></h1></body>`,
        },
        {
            name: 'remove',
            content: { remove: true },
            expected: `<body><head>${componentsTag}</head></body>`,
        },
        {
            name: 'before + after + remove',
            content: {
                before: [{ type: 'html', content: 'BEFORE' } as const],
                after: [{ type: 'text', content: 'AFTER' } as const],
                remove: true,
            },
            expected: `<body><head>${componentsTag}</head>BEFOREAFTER</body>`,
        },
        {
            name: 'append + after',
            content: {
                after: [{ type: 'html', content: '<p>AFTER</p>' } as const],
                append: [{ type: 'html', content: '<p>APPEND</p>' } as const],
            },
            expected: `<body><head>${componentsTag}</head><h1>Test<p>APPEND</p></h1><p>AFTER</p></body>`,
        },
        {
            name: 'append + prepend + remove -> removes element and ignores append',
            content: {
                remove: true,
                append: [{ type: 'html', content: '<p>APPEND</p>' } as const],
                prepend: [{ type: 'html', content: '<p>PREPEND</p>' } as const],
            },
            expected: `<body><head>${componentsTag}</head></body>`,
        },
        {
            name: 'ignore custom',
            content: {
                before: [{ type: 'custom', content: 'UNKNOWN' } as const],
            },
            expected: `<body><head>${componentsTag}</head><h1>Test</h1></body>`,
        },
        {
            name: 'MOS element',
            content: {
                before: [
                    {
                        type: 'element',
                        schema: 'mos:test@1.0',
                        props: {
                            prop1: 'value1',
                            prop2: true,
                        },
                    } as const,
                ],
            },
            expected: `<body><head>${componentsTag}</head><mos-test version="1.0" props="{&quot;prop1&quot;:&quot;value1&quot;,&quot;prop2&quot;:true}"></mos-test><h1>Test</h1></body>`,
        },
        {
            name: ':last-child selector is ignored',
            content: { before: [{ type: 'html', content: 'BEFORE' } as const] },
            expected: `<body><head></head><h1>Test</h1></body>`,
            cssSelector: 'h1:last-child',
        },
        {
            name: 'junk CSS selector is ignored',
            content: { before: [{ type: 'html', content: 'BEFORE' } as const] },
            expected: `<body><head></head><h1>Test</h1></body>`,
            cssSelector: '&&&invalid###',
        },
    ])('rewrites HTML component content - $name', async ({ content, expected, ...rest }) => {
        const cssSelector = 'cssSelector' in rest ? rest.cssSelector : 'h1'
        const page = new Response('<body><head></head><h1>Test</h1></body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        const decision = decisions({ test: { metadata: { cssSelector }, content: content as WebContentSurfaceBehavior } })
        const result = await handleSurfaceComponents(ctx, page, decision, new LolHtmlRewriter())
        expect(await result.text()).toBe(expected)
    })
})
