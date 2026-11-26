const NO_BODY_STATUSES = new Set([204, 205, 304])

export const statusAllowsBody = (status: number) => status >= 200 && !NO_BODY_STATUSES.has(status)

/** Media types are case-insensitive. */
export const isHtmlContentType = (contentType: string | null | undefined) => contentType?.toLowerCase().startsWith('text/html') ?? false

/** A response's status, for a new response around its body or another. */
export const responseInit = (response: Response, headers: HeadersInit = response.headers): ResponseInit => ({
    status: response.status,
    statusText: response.statusText,
    headers,
})
