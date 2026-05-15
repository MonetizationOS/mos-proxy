const protocolPattern = '(https?:)?//'

/** Single-shot rewriter. Convenient for tests and one-offs. Hot paths should prefer
 *  `compileOriginLinkRewriter` which amortizes regex construction across many invocations. */
export default function transformOriginLinks(requestUrl: URL, originUrl: URL, input: string): string {
    return compileOriginLinkRewriter(requestUrl, originUrl)(input)
}

/**
 * Precompiles a rewriter for a (request, origin) pair. The returned function is safe to call
 * thousands of times per page (one per attribute / text-node). It short-circuits on a native
 * `includes()` of the origin hostname, which is by far the common case: most attribute values
 * don't reference the origin host at all.
 */
export function compileOriginLinkRewriter(requestUrl: URL, originUrl: URL): (input: string) => string {
    return compileOriginLinkRewriterInternal(requestUrl, originUrl).rewrite
}

/**
 * Exposes the raw regex / replacement / hostname / maxMatch so streaming consumers (which need
 * to detect matches straddling chunk boundaries) can reuse the precompiled regex without
 * rebuilding it. Most callers should use `compileOriginLinkRewriter`.
 */
export interface CompiledOriginRewriter {
    rewrite: (input: string) => string
    regex: RegExp
    replacement: string
    originHostname: string
    maxMatchLength: number
}

export function compileOriginLinkRewriterInternal(requestUrl: URL, originUrl: URL): CompiledOriginRewriter {
    const originPort = originUrl.port ? `:${originUrl.port}` : ''
    const originBasePath = originUrl.pathname.replace(/\/$/, '')
    const originHostname = originUrl.hostname
    const regex = new RegExp(`${protocolPattern}${escapeRegExp(`${originHostname}${originPort}${originBasePath}`)}`, 'g')

    const requestPort = requestUrl.port ? `:${requestUrl.port}` : ''
    const replacement = `${requestUrl.protocol}//${requestUrl.hostname}${requestPort}`

    // Longest possible match: "https://" + originBase. Streaming consumers must hold back this
    // many trailing chars at a chunk boundary so a match split across chunks isn't missed.
    const maxMatchLength = 'https://'.length + originHostname.length + originPort.length + originBasePath.length

    const rewrite = (input: string) => {
        if (!input?.includes(originHostname)) return input
        return input.replaceAll(regex, replacement)
    }

    return { rewrite, regex, replacement, originHostname, maxMatchLength }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
