import { describe, expect, it } from 'vitest'
import isRedirectResponse from '../../src/stages/isRedirectResponse'

describe('isRedirectResponse', () => {
    it('returns true for 3xx responses', () => {
        expect(isRedirectResponse(new Response(null, { status: 301 }))).toBe(true)
        expect(isRedirectResponse(new Response(null, { status: 302 }))).toBe(true)
        expect(isRedirectResponse(new Response(null, { status: 308 }))).toBe(true)
    })

    it('returns false for 2xx, 4xx, 5xx', () => {
        expect(isRedirectResponse(new Response(null, { status: 200 }))).toBe(false)
        expect(isRedirectResponse(new Response(null, { status: 404 }))).toBe(false)
        expect(isRedirectResponse(new Response(null, { status: 500 }))).toBe(false)
    })
})
