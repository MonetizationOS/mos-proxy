/** Origin links are rewritten with any of these before `//`; '' is a protocol-relative link */
const LINK_PROTOCOLS = ['https:', 'http:', '']
const protocolPattern = `(${LINK_PROTOCOLS.filter(Boolean).join('|')})?//`

export interface OriginLinkStreamRewriter {
    /** Rewrites what can be rewritten so far; holds back a tail that a later chunk could change. */
    push(input: string): string
    /** Rewrites and returns the held-back tail. */
    end(): string
}

interface CompiledOriginLink {
    regex: RegExp
    replacement: string
    /** Literal forms a match can take, without the boundary lookahead. */
    forms: string[]
}

function compile(requestUrl: URL, originUrl: URL): CompiledOriginLink {
    const originPort = originUrl.port ? `:${originUrl.port}` : ''
    const originBasePath = originUrl.pathname.replace(/\/$/, '')
    const originPrefix = `${originUrl.hostname}${originPort}${originBasePath}`
    const boundary = '(?![a-zA-Z0-9._~%-])'
    const regex = new RegExp(`${protocolPattern}${escapeRegExp(originPrefix)}${boundary}`, 'g')

    const requestPort = requestUrl.port ? `:${requestUrl.port}` : ''
    const replacement = `${requestUrl.protocol}//${requestUrl.hostname}${requestPort}`

    return { regex, replacement, forms: LINK_PROTOCOLS.map((protocol) => `${protocol}//${originPrefix}`) }
}

export default function compileOriginLinkRewriter(requestUrl: URL, originUrl: URL): (input: string) => string {
    const { regex, replacement } = compile(requestUrl, originUrl)
    return (input: string) => (input ? input.replaceAll(regex, replacement) : input)
}

/** Same output as `compileOriginLinkRewriter` over the joined input, however it is split. */
export function createOriginLinkStreamRewriter(requestUrl: URL, originUrl: URL): OriginLinkStreamRewriter {
    const { regex, replacement, forms } = compile(requestUrl, originUrl)
    const longestForm = Math.max(...forms.map((form) => form.length))
    let pending = ''

    // First position whose text could still grow into a match, or its boundary lookahead.
    const holdFrom = (text: string) => {
        for (let i = Math.max(0, text.length - longestForm); i < text.length; i++) {
            const tail = text.slice(i)
            if (forms.some((form) => form.startsWith(tail))) return i
        }
        return text.length
    }

    return {
        push(input) {
            pending += input
            const hold = holdFrom(pending)

            let output = ''
            let last = 0
            for (const match of pending.matchAll(regex)) {
                if (match.index >= hold) break
                output += pending.slice(last, match.index) + replacement
                last = match.index + match[0].length
            }
            const cut = Math.max(hold, last)

            output += pending.slice(last, cut)
            pending = pending.slice(cut)
            return output
        },
        end() {
            const output = pending ? pending.replaceAll(regex, replacement) : pending
            pending = ''
            return output
        },
    }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
