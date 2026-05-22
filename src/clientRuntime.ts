export type ClientRuntime = {
    runtime: 'cloudflare-workers' | 'fastly-compute' | 'vercel-edge' | 'deno-deploy' | 'deno' | 'bun' | 'node' | 'browser' | 'unknown'
    runtimeVersion?: string
    provider?: 'vercel' | 'aws-lambda' | 'cloud-run' | 'netlify'
}

const NODE_PROVIDER_ENV: ReadonlyArray<readonly [string, NonNullable<ClientRuntime['provider']>]> = [
    ['VERCEL', 'vercel'],
    ['AWS_LAMBDA_FUNCTION_NAME', 'aws-lambda'],
    ['K_SERVICE', 'cloud-run'],
    ['NETLIFY', 'netlify'],
]

const detectNodeProvider = (env: Record<string, string | undefined>): ClientRuntime['provider'] => {
    for (const [key, provider] of NODE_PROVIDER_ENV) {
        if (env[key]) return provider
    }
    return undefined
}

export const getClientRuntime = (): ClientRuntime => {
    // Edge runtimes first: some (Vercel Edge, Deno Deploy) also expose a partial `process` shim,
    // so a Node check earlier would match them by mistake.
    try {
        // biome-ignore lint/suspicious/noExplicitAny: runtime globals are not typed
        const g = globalThis as any
        if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
            return { runtime: 'cloudflare-workers' }
        }
        if (typeof g.fastly !== 'undefined') {
            return { runtime: 'fastly-compute' }
        }
        if (typeof g.EdgeRuntime !== 'undefined') {
            return { runtime: 'vercel-edge' }
        }
        if (typeof g.Deno !== 'undefined') {
            const version = g.Deno.version?.deno
            return g.Deno.env?.get?.('DENO_DEPLOYMENT_ID')
                ? { runtime: 'deno-deploy', runtimeVersion: version }
                : { runtime: 'deno', runtimeVersion: version }
        }
        if (typeof g.Bun !== 'undefined') {
            return { runtime: 'bun', runtimeVersion: g.Bun.version }
        }
        const proc = g.process
        if (proc?.versions?.node) {
            return { runtime: 'node', runtimeVersion: proc.versions.node, provider: detectNodeProvider(proc.env ?? {}) }
        }
        if (typeof window !== 'undefined') {
            return { runtime: 'browser' }
        }
    } catch {
        // Sandboxed environments may throw on bare global property access; fall through to 'unknown'.
    }
    return { runtime: 'unknown' }
}

export const formatClientRuntimeHeader = (info: ClientRuntime = getClientRuntime()): string => {
    const parts = [`runtime=${info.runtime}`]
    if (info.runtimeVersion) parts.push(`runtime-version=${info.runtimeVersion}`)
    if (info.provider) parts.push(`provider=${info.provider}`)
    return parts.join('; ')
}
