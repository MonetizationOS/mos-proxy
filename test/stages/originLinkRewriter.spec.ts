import { describe, expect, it } from 'vitest'
import compileOriginLinkRewriter from '../../src/stages/originLinkRewriter'

const rewrite = (requestUrl: URL, originUrl: URL, input: string) => compileOriginLinkRewriter(requestUrl, originUrl)(input)

describe('compileOriginLinkRewriter', () => {
    const requestUrl = new URL('https://proxy.example.com/')
    const originUrl = new URL('https://origin.example.com/')

    it('rewrites absolute https origin URLs to proxy URLs', () => {
        const out = rewrite(requestUrl, originUrl, '<a href="https://origin.example.com/foo">x</a>')
        expect(out).toBe('<a href="https://proxy.example.com/foo">x</a>')
    })

    it('rewrites protocol-relative origin URLs', () => {
        const out = rewrite(requestUrl, originUrl, '<a href="//origin.example.com/foo">x</a>')
        expect(out).toBe('<a href="https://proxy.example.com/foo">x</a>')
    })

    it('leaves unrelated hostnames alone', () => {
        const input = '<a href="https://other.example.com/foo">x</a>'
        expect(rewrite(requestUrl, originUrl, input)).toBe(input)
    })

    it('returns empty input unchanged', () => {
        expect(rewrite(requestUrl, originUrl, '')).toBe('')
    })

    it('handles origin with base path', () => {
        const out = rewrite(requestUrl, new URL('https://origin.example.com/prefix'), 'https://origin.example.com/prefix/x')
        expect(out).toBe('https://proxy.example.com/x')
    })

    it('rewrites origin URLs correctly when an origin port is present', () => {
        const out = rewrite(requestUrl, new URL('https://origin.example.com:8443'), 'https://origin.example.com:8443/foo')
        expect(out).toBe('https://proxy.example.com/foo')
    })

    it('does not rewrite hostnames that extend past the origin host', () => {
        const input = '<a href="https://origin.example.com.evil/foo">x</a>'
        expect(rewrite(requestUrl, originUrl, input)).toBe(input)
    })

    it('does not rewrite path prefixes that extend past the origin base path', () => {
        expect(rewrite(requestUrl, new URL('https://origin.example.com/prefix'), 'https://origin.example.com/prefix2/x')).toBe(
            'https://origin.example.com/prefix2/x',
        )
    })

    it('reuses one compiled rewriter across calls', () => {
        const r = compileOriginLinkRewriter(requestUrl, originUrl)
        expect(r('https://origin.example.com/a')).toBe('https://proxy.example.com/a')
        expect(r('https://origin.example.com/b')).toBe('https://proxy.example.com/b')
    })
})
