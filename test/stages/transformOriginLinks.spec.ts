import { describe, expect, it } from 'vitest'
import transformOriginLinks from '../../src/stages/transformOriginLinks'

describe('transformOriginLinks', () => {
    const requestUrl = new URL('https://proxy.example.com/')
    const originUrl = new URL('https://origin.example.com/')

    it('rewrites absolute https origin URLs to proxy URLs', () => {
        const out = transformOriginLinks(requestUrl, originUrl, '<a href="https://origin.example.com/foo">x</a>')
        expect(out).toBe('<a href="https://proxy.example.com/foo">x</a>')
    })

    it('rewrites protocol-relative origin URLs', () => {
        const out = transformOriginLinks(requestUrl, originUrl, '<a href="//origin.example.com/foo">x</a>')
        expect(out).toBe('<a href="https://proxy.example.com/foo">x</a>')
    })

    it('leaves unrelated hostnames alone', () => {
        const input = '<a href="https://other.example.com/foo">x</a>'
        expect(transformOriginLinks(requestUrl, originUrl, input)).toBe(input)
    })

    it('returns empty input unchanged', () => {
        expect(transformOriginLinks(requestUrl, originUrl, '')).toBe('')
    })

    it('handles origin with base path', () => {
        const out = transformOriginLinks(requestUrl, new URL('https://origin.example.com/prefix'), 'https://origin.example.com/prefix/x')
        expect(out).toBe('https://proxy.example.com/x')
    })

    it('preserves origin port when present', () => {
        const out = transformOriginLinks(requestUrl, new URL('https://origin.example.com:8443'), 'https://origin.example.com:8443/foo')
        expect(out).toBe('https://proxy.example.com/foo')
    })
})
