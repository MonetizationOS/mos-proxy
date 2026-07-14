import { formatClientRuntimeHeader } from './clientRuntime'

export const MOS_PROXY_VERSION_HEADER = 'X-MOS-Proxy-Version'
export const MOS_PROXY_CLIENT_HEADER = 'X-MOS-Proxy-Client'
export const MOS_PROXY_PACKAGE_VERSION = '1.5.1'

export const setMosProxyHeaders = (headers: Headers): void => {
    headers.set(MOS_PROXY_VERSION_HEADER, MOS_PROXY_PACKAGE_VERSION)
    headers.set(MOS_PROXY_CLIENT_HEADER, formatClientRuntimeHeader())
}

export const withMosProxyHeaders = (headers?: HeadersInit): Headers => {
    const next = new Headers(headers)
    setMosProxyHeaders(next)
    return next
}
