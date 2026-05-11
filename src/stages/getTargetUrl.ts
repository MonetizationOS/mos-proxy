export default function getTargetUrl(requestUrl: URL, originUrl: URL): URL {
    const target = new URL(requestUrl)
    target.protocol = originUrl.protocol
    target.host = originUrl.host
    target.port = originUrl.port
    target.pathname = originUrl.pathname.replace(/\/$/, '') + target.pathname
    return target
}
