/**
 * Provides the end-user client IP for the MOS API `http.clientIP` field.
 * Each CDN runtime supplies its own provider via {@link MOSProxyBuilder.withClientIP}.
 */
export type ClientIPProvider = (request: Request) => string | null | undefined

export const normalizeClientIP = (value: string | null | undefined): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
