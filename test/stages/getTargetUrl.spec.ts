import { describe, expect, it } from 'vitest'
import getTargetUrl from '../../src/stages/getTargetUrl'

describe('getTargetUrl', () => {
    it('replaces protocol/host/port with origin', () => {
        const target = getTargetUrl(new URL('https://proxy.example.com/article'), new URL('https://origin.example.com'))
        expect(target.toString()).toBe('https://origin.example.com/article')
    })

    it('preserves query string', () => {
        const target = getTargetUrl(new URL('https://proxy.example.com/x?a=1&b=2'), new URL('https://origin.example.com'))
        expect(target.search).toBe('?a=1&b=2')
    })

    it('merges origin base path with request path', () => {
        const target = getTargetUrl(new URL('https://proxy.example.com/page'), new URL('https://origin.example.com/prefix'))
        expect(target.pathname).toBe('/prefix/page')
    })

    it('strips trailing slash on origin base path', () => {
        const target = getTargetUrl(new URL('https://proxy.example.com/page'), new URL('https://origin.example.com/prefix/'))
        expect(target.pathname).toBe('/prefix/page')
    })

    it('handles non-default ports on origin', () => {
        const target = getTargetUrl(new URL('https://proxy.example.com/page'), new URL('https://origin.example.com:8443'))
        expect(target.host).toBe('origin.example.com:8443')
        expect(target.port).toBe('8443')
    })
})
