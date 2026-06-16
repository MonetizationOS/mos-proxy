import { describe, expect, it } from 'vitest'
import { selectSurfaceDecisionCookies } from '../src/surfaceDecisionCookies'

const originResponseWithSetCookie = (...cookies: string[]) => {
    const headers = new Headers()
    for (const cookie of cookies) {
        headers.append('Set-Cookie', cookie)
    }
    return new Response(null, { headers })
}

describe('selectSurfaceDecisionCookies', () => {
    it('returns undefined when no patterns are configured', () => {
        expect(selectSurfaceDecisionCookies('session=abc', undefined, [])).toBeUndefined()
    })

    it('returns undefined when no cookies match the configured patterns', () => {
        expect(selectSurfaceDecisionCookies('other=1', undefined, [/^session$/])).toBeUndefined()
    })

    it('selects cookies whose names match an exact pattern from the request', () => {
        expect(selectSurfaceDecisionCookies('session=abc; theme=dark; other=1', undefined, [/^session$/, /^theme$/])).toEqual({
            session: 'abc',
            theme: 'dark',
        })
    })

    it('selects cookies whose names match a regex pattern from the request', () => {
        expect(selectSurfaceDecisionCookies('mos_session=abc; wp_session=def; other=1', undefined, [/^mos_/])).toEqual({
            mos_session: 'abc',
        })
    })

    it('selects matching cookies from the origin Set-Cookie headers when the request has none', () => {
        expect(
            selectSurfaceDecisionCookies(null, originResponseWithSetCookie('theme=dark; Path=/', 'ignored=1; Path=/'), [/^theme$/]),
        ).toEqual({
            theme: 'dark',
        })
    })

    it('prefers origin Set-Cookie values over the request when both match the same name', () => {
        expect(selectSurfaceDecisionCookies('theme=old', originResponseWithSetCookie('theme=new; Path=/'), [/^theme$/])).toEqual({
            theme: 'new',
        })
    })

    it('merges matching cookies from both the request and origin response', () => {
        expect(
            selectSurfaceDecisionCookies('__session=from-request', originResponseWithSetCookie('theme=from-origin; Path=/'), [
                /^__session$/,
                /^theme$/,
            ]),
        ).toEqual({
            __session: 'from-request',
            theme: 'from-origin',
        })
    })
})
