const protocolPattern = '(https?:)?//'

export default function compileOriginLinkRewriter(requestUrl: URL, originUrl: URL): (input: string) => string {
    const originPort = originUrl.port ? `:${originUrl.port}` : ''
    const originBasePath = originUrl.pathname.replace(/\/$/, '')
    const boundary = '(?![a-zA-Z0-9._~%-])'
    const regex = new RegExp(`${protocolPattern}${escapeRegExp(`${originUrl.hostname}${originPort}${originBasePath}`)}${boundary}`, 'g')

    const requestPort = requestUrl.port ? `:${requestUrl.port}` : ''
    const replacement = `${requestUrl.protocol}//${requestUrl.hostname}${requestPort}`

    return (input: string) => (input ? input.replaceAll(regex, replacement) : input)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
