import { describe, expect, it } from 'vitest'
import { readExpiredJwt } from '../src/jwt'

const encode = (value: object) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    let binary = ''
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const jwt = (payload: Record<string, unknown>) => `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`

describe('readExpiredJwt', () => {
    const nowSeconds = 1_700_000_000

    it('returns claims when exp is in the past', () => {
        const token = jwt({ sub: 'user-1', exp: nowSeconds - 1 })

        expect(readExpiredJwt(token, nowSeconds)).toEqual({
            claims: { sub: 'user-1', exp: nowSeconds - 1 },
            expiredAt: nowSeconds - 1,
        })
    })

    it('treats exp equal to now as expired', () => {
        const token = jwt({ exp: nowSeconds })

        expect(readExpiredJwt(token, nowSeconds)?.expiredAt).toBe(nowSeconds)
    })

    it('returns null when the token is still valid', () => {
        expect(readExpiredJwt(jwt({ exp: nowSeconds + 1 }), nowSeconds)).toBeNull()
    })

    it('returns null when exp is missing or not a number', () => {
        expect(readExpiredJwt(jwt({ sub: 'user-1' }), nowSeconds)).toBeNull()
        expect(readExpiredJwt(jwt({ exp: '1700000000' }), nowSeconds)).toBeNull()
    })

    it('returns null for tokens that are not JWTs', () => {
        expect(readExpiredJwt('not-a-jwt', nowSeconds)).toBeNull()
        expect(readExpiredJwt('a.%%%not-base64%%%.c', nowSeconds)).toBeNull()
        expect(readExpiredJwt('', nowSeconds)).toBeNull()
    })

    it('decodes unicode claims', () => {
        const token = jwt({ name: 'José', exp: 1 })

        expect(readExpiredJwt(token, nowSeconds)?.claims.name).toBe('José')
    })
})
