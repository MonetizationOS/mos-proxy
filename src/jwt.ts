export interface ExpiredJwt {
    claims: Record<string, unknown>
    /** `exp` claim as unix seconds. */
    expiredAt: number
}

/**
 * Reads an unverified JWT payload and returns it when `exp` is in the past.
 * Returns null when the token is missing, not a JWT, has no numeric `exp`, or is still valid.
 * Signature is not checked — callers use this only to notice expiry, not to authenticate.
 */
export function readExpiredJwt(token: string, nowSeconds = Date.now() / 1000): ExpiredJwt | null {
    const claims = decodeJwtClaims(token)
    if (!claims) {
        return null
    }

    const expiredAt = claims.exp
    if (typeof expiredAt !== 'number' || !Number.isFinite(expiredAt) || nowSeconds < expiredAt) {
        return null
    }

    return { claims, expiredAt }
}

const decodeJwtClaims = (token: string): Record<string, unknown> | null => {
    const payload = token.split('.')[1]
    if (!payload) {
        return null
    }

    try {
        const json = decodeBase64Url(payload)
        const claims: unknown = JSON.parse(json)
        if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
            return null
        }
        return claims as Record<string, unknown>
    } catch {
        return null
    }
}

const decodeBase64Url = (value: string): string => {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
}
