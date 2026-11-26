const NO_BODY_STATUSES = new Set([204, 205, 304])

export const statusAllowsBody = (status: number) => status >= 200 && !NO_BODY_STATUSES.has(status)

/** Media types are case-insensitive. */
const hasMediaType = (contentType: string | null | undefined, mediaType: string) =>
    contentType?.toLowerCase().startsWith(mediaType) ?? false

export const isHtmlContentType = (contentType: string | null | undefined) => hasMediaType(contentType, 'text/html')

export const isByteRangesContentType = (contentType: string | null | undefined) => hasMediaType(contentType, 'multipart/byteranges')

/** A response's status, for a new response around its body or another. */
export const responseInit = (response: Response, headers: HeadersInit = response.headers): ResponseInit => ({
    status: response.status,
    statusText: response.statusText,
    headers,
})
