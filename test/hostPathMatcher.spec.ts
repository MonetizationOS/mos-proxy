import { describe, expect, it } from 'vitest'
import { hostPathMatcher } from '../src/hostPathMatcher'
import type { MOSConfigInput } from '../src/types'

// Full configs — the matcher returns a complete MOSConfigInput.
const cfg = (slug: string): MOSConfigInput => ({
    originUrl: `https://${slug}.example.com`,
    surfaceSlug: slug,
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
})

// `satisfies` (not a `Partial` annotation) keeps base's precise keys so configs are compile-time-checked.
const base = {
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
} satisfies Partial<MOSConfigInput>

const resolve = (matcher: ReturnType<typeof hostPathMatcher>, url: string) => matcher(new Request(url))

describe('hostPathMatcher', () => {
    const matcher = hostPathMatcher([
        { host: 'acme.com', config: cfg('default') },
        { host: 'acme.com', pathPrefix: '/news', config: cfg('news') },
        { host: 'acme.com', pathPrefix: '/shop', config: cfg('shop') },
    ])

    it('matches the most specific (longest) path prefix, regardless of declaration order', () => {
        expect(resolve(matcher, 'https://acme.com/news/article-1')).toEqual(cfg('news'))
        expect(resolve(matcher, 'https://acme.com/shop/cart')).toEqual(cfg('shop'))
    })

    it('falls back to the host catch-all when no path prefix matches', () => {
        expect(resolve(matcher, 'https://acme.com/about')).toEqual(cfg('default'))
    })

    it('matches a path prefix exactly and at its trailing slash', () => {
        expect(resolve(matcher, 'https://acme.com/news')).toEqual(cfg('news'))
        expect(resolve(matcher, 'https://acme.com/news/')).toEqual(cfg('news'))
    })

    it('matches on segment boundaries, not raw string prefixes', () => {
        // `/newsletter` must NOT match the `/news` rule.
        expect(resolve(matcher, 'https://acme.com/newsletter')).toEqual(cfg('default'))
    })

    it('throws when nothing matches and there is no fallback rule', () => {
        expect(() => resolve(matcher, 'https://other.com/news')).toThrow(/no rule matched/)
    })

    it('matches the host case-insensitively', () => {
        expect(resolve(hostPathMatcher([{ host: 'Acme.COM', config: cfg('default') }]), 'https://acme.com/x')).toEqual(cfg('default'))
    })

    it('matches a bare host rule against a request carrying a non-default port', () => {
        // url.host would be `acme.com:8443`; matching must use the port-free hostname.
        expect(resolve(matcher, 'https://acme.com:8443/news/x')).toEqual(cfg('news'))
    })

    it('breaks equal-length-prefix ties by declaration order (first wins)', () => {
        const tie = hostPathMatcher([
            { host: 'acme.com', pathPrefix: '/news', config: cfg('first') },
            { host: 'acme.com', pathPrefix: '/news', config: cfg('second') },
        ])
        expect(resolve(tie, 'https://acme.com/news/x')).toEqual(cfg('first'))
    })

    it('normalizes configured prefixes (leading/trailing slashes are optional)', () => {
        const m = hostPathMatcher([{ host: 'acme.com', pathPrefix: 'news/', config: cfg('news') }])
        expect(resolve(m, 'https://acme.com/news/x')).toEqual(cfg('news'))
    })

    it('treats pathPrefix "/" (or empty/only-slashes) as a host catch-all, not root-only', () => {
        for (const pathPrefix of ['/', '', '//']) {
            const m = hostPathMatcher([{ host: 'acme.com', pathPrefix, config: cfg('all') }])
            expect(resolve(m, 'https://acme.com/')).toEqual(cfg('all'))
            expect(resolve(m, 'https://acme.com/deep/path')).toEqual(cfg('all'))
        }
    })

    describe('base + partial overrides', () => {
        const matcher = hostPathMatcher(
            [
                { host: 'acme.com', pathPrefix: '/news', config: { originUrl: 'https://news.acme.com', surfaceSlug: 'news' } },
                { host: 'acme.com', config: { originUrl: 'https://acme.com', surfaceSlug: 'acme' } },
            ],
            base,
        )

        it('shallow-merges each rule config over the base into a complete config', () => {
            expect(resolve(matcher, 'https://acme.com/news/x')).toEqual({
                ...base,
                originUrl: 'https://news.acme.com',
                surfaceSlug: 'news',
            })
            expect(resolve(matcher, 'https://acme.com/other')).toEqual({ ...base, originUrl: 'https://acme.com', surfaceSlug: 'acme' })
        })

        it('lets a rule override a base field', () => {
            const m = hostPathMatcher(
                [{ host: 'acme.com', config: { originUrl: 'https://acme.com', surfaceSlug: 'acme', mosSecretKey: 'sk_env_override' } }],
                base,
            )
            expect(resolve(m, 'https://acme.com/x')).toMatchObject({ mosSecretKey: 'sk_env_override' })
        })

        it('works with no base (each rule carries a full config)', () => {
            const m = hostPathMatcher([{ host: 'acme.com', config: cfg('default') }])
            expect(resolve(m, 'https://acme.com/x')).toEqual(cfg('default'))
        })
    })

    describe('host-less rules', () => {
        const part = (slug: string) => ({ originUrl: `https://${slug}.example.com`, surfaceSlug: slug })
        const matcher = hostPathMatcher(
            [
                { host: 'acme.com', config: part('acme') }, // host catch-all
                { pathPrefix: '/news', config: part('news') }, // host-less, any host
                { pathPrefix: '/shop/deals', config: part('deals') }, // host-less, deeper path
                { config: part('global') }, // host-less, path-less global catch-all
            ],
            base,
        )

        const expectSlug = (url: string, slug: string) => expect(resolve(matcher, url)).toEqual({ ...base, ...part(slug) })

        it('matches a host-less path rule across any host', () => {
            expectSlug('https://other.com/news/article', 'news')
            expectSlug('https://whatever.io/shop/deals/x', 'deals')
        })

        it('picks the longest matching host-less prefix, falling back to the global catch-all', () => {
            expectSlug('https://other.com/shop/deals/x', 'deals')
            expectSlug('https://other.com/shop/other', 'global')
            expectSlug('https://other.com/anything', 'global')
        })

        it('lets a matched host beat host-less rules, even a longer host-less path', () => {
            // acme.com's catch-all (prefix len 0) still wins over the host-less /news rule.
            expectSlug('https://acme.com/news/article', 'acme')
        })

        it('allows many host-less rules as long as only one is path-less', () => {
            expect(() =>
                hostPathMatcher([
                    { pathPrefix: '/a', config: cfg('a') },
                    { pathPrefix: '/b', config: cfg('b') },
                ]),
            ).not.toThrow()
        })

        it('throws at construction when more than one host-less, path-less catch-all is given', () => {
            expect(() => hostPathMatcher([{ config: cfg('a') }, { config: cfg('b') }])).toThrow(/only one host-less, path-less/)
        })
    })
})
