import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatClientRuntimeHeader, getClientRuntime } from '../src/clientRuntime'

const stub = (key: string, value: unknown) => {
    // biome-ignore lint/suspicious/noExplicitAny: test global stubbing
    vi.stubGlobal(key, value as any)
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('clientRuntime', () => {
    it('detects Cloudflare Workers via navigator.userAgent', () => {
        stub('navigator', { userAgent: 'Cloudflare-Workers' })
        expect(getClientRuntime()).toEqual({ runtime: 'cloudflare-workers' })
    })

    it('detects Fastly Compute via globalThis.fastly', () => {
        stub('fastly', {})
        expect(getClientRuntime()).toEqual({ runtime: 'fastly-compute' })
    })

    it('detects Vercel Edge via EdgeRuntime global', () => {
        stub('EdgeRuntime', 'vercel')
        expect(getClientRuntime()).toEqual({ runtime: 'vercel-edge' })
    })

    it('detects Deno Deploy when DENO_DEPLOYMENT_ID is set', () => {
        stub('Deno', {
            version: { deno: '1.40.0' },
            env: { get: (k: string) => (k === 'DENO_DEPLOYMENT_ID' ? 'abc' : undefined) },
        })
        expect(getClientRuntime()).toEqual({ runtime: 'deno-deploy', runtimeVersion: '1.40.0' })
    })

    it('detects plain Deno when DENO_DEPLOYMENT_ID is absent', () => {
        stub('Deno', { version: { deno: '1.40.0' }, env: { get: () => undefined } })
        expect(getClientRuntime()).toEqual({ runtime: 'deno', runtimeVersion: '1.40.0' })
    })

    it('detects Bun via globalThis.Bun', () => {
        stub('Bun', { version: '1.1.0' })
        expect(getClientRuntime()).toEqual({ runtime: 'bun', runtimeVersion: '1.1.0' })
    })

    it('detects Node and surfaces Vercel provider', () => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing process via globalThis to keep tsconfig Node-free
        const proc = (globalThis as any).process
        const prev = proc.env.VERCEL
        proc.env.VERCEL = '1'
        try {
            const info = getClientRuntime()
            expect(info.runtime).toBe('node')
            expect(info.runtimeVersion).toBe(proc.versions.node)
            expect(info.provider).toBe('vercel')
        } finally {
            if (prev === undefined) delete proc.env.VERCEL
            else proc.env.VERCEL = prev
        }
    })

    it('formats the header with runtime, version, and provider', () => {
        expect(formatClientRuntimeHeader({ runtime: 'node', runtimeVersion: '20.0.0', provider: 'aws-lambda' })).toBe(
            'runtime=node; runtime-version=20.0.0; provider=aws-lambda',
        )
    })

    it('formats the header with just the runtime when nothing else is known', () => {
        expect(formatClientRuntimeHeader({ runtime: 'cloudflare-workers' })).toBe('runtime=cloudflare-workers')
    })
})
