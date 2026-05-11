import { describe, expect, it } from 'vitest'
import handleSurfaceBehavior from '../../src/stages/surfaceBehavior'
import type { SurfaceDecisionResponse } from '../../src/types'

const makeDecisions = (http: Record<string, unknown>): SurfaceDecisionResponse =>
    ({
        status: 'success',
        identity: { identifier: '', isAuthenticated: false, authType: '', jwtClaims: {} },
        features: {},
        customer: { hasProducts: false },
        surfaceBehavior: { http },
        componentsSkipped: false,
        componentBehaviors: {},
    }) as unknown as SurfaceDecisionResponse

describe('handleSurfaceBehavior', () => {
    it('returns response unchanged when no http mutations are present', async () => {
        const response = new Response('body', { status: 200 })
        const [out, returnImmediately] = handleSurfaceBehavior(response, makeDecisions({}))
        expect(returnImmediately).toBe(false)
        expect(out).toBe(response)
    })

    it('overrides status code', async () => {
        const [out] = handleSurfaceBehavior(new Response('body', { status: 200 }), makeDecisions({ status: 402 }))
        expect(out.status).toBe(402)
    })

    it('replaces body and sets returnImmediately', async () => {
        const [out, returnImmediately] = handleSurfaceBehavior(new Response('origin', { status: 200 }), makeDecisions({ body: 'paywall' }))
        expect(returnImmediately).toBe(true)
        expect(await out.text()).toBe('paywall')
    })

    it('adds headers', async () => {
        const [out] = handleSurfaceBehavior(
            new Response('body', { status: 200 }),
            makeDecisions({ addHeaders: [{ name: 'X-MOS', value: 'on' }] }),
        )
        expect(out.headers.get('X-MOS')).toBe('on')
    })

    it('removes headers', async () => {
        const [out] = handleSurfaceBehavior(
            new Response('body', { status: 200, headers: { 'X-Origin': 'v' } }),
            makeDecisions({ removeHeaders: ['X-Origin'] }),
        )
        expect(out.headers.get('X-Origin')).toBeNull()
    })

    it('adds Set-Cookie entries without removing existing ones', async () => {
        const [out] = handleSurfaceBehavior(
            new Response('body', { status: 200, headers: { 'Set-Cookie': 'a=1' } }),
            makeDecisions({ addCookies: ['b=2'] }),
        )
        expect(out.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    })

    it('replaces cookies when http.cookies is set', async () => {
        const [out] = handleSurfaceBehavior(
            new Response('body', { status: 200, headers: { 'Set-Cookie': 'a=1' } }),
            makeDecisions({ cookies: ['b=2', 'c=3'] }),
        )
        expect(out.headers.getSetCookie()).toEqual(['b=2', 'c=3'])
    })

    it.each([204, 205, 304])('drops the body when status is overridden to %s', async (status) => {
        // Regression: new Response(body, { status: 204|205|304 }) throws. Honor the no-body invariant.
        const [out] = handleSurfaceBehavior(new Response('origin', { status: 200 }), makeDecisions({ status }))
        expect(out.status).toBe(status)
        expect(out.body).toBeNull()
    })

    it('drops the surface-provided body when status is also overridden to a no-body code', async () => {
        const [out] = handleSurfaceBehavior(new Response('origin', { status: 200 }), makeDecisions({ status: 204, body: 'paywall' }))
        expect(out.status).toBe(204)
        expect(out.body).toBeNull()
    })
})
