export const MOS_PROXY_VERSION_HEADER = 'X-MOS-Proxy-Version'
export const MOS_PROXY_PACKAGE_VERSION = '1.0.1'

export const setMosProxyVersionHeader = (headers: Headers): void => {
    headers.set(MOS_PROXY_VERSION_HEADER, MOS_PROXY_PACKAGE_VERSION)
}

export const withMosProxyVersionHeader = (headers?: HeadersInit): Headers => {
    const next = new Headers(headers)
    setMosProxyVersionHeader(next)
    return next
}
