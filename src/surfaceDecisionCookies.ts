import { parse, parseSetCookie } from 'cookie'

export function selectSurfaceDecisionCookies(
    cookieHeader: string | null,
    originResponse: Response | undefined,
    patterns: RegExp[],
): Record<string, string> | undefined {
    if (patterns.length === 0) {
        return undefined
    }

    const selected: Record<string, string> = {}

    for (const [name, value] of Object.entries(parse(cookieHeader || ''))) {
        if (value === undefined) continue
        if (patterns.some((pattern) => pattern.test(name))) {
            selected[name] = value
        }
    }

    const setCookies = originResponse?.headers.getSetCookie().map((header) => parseSetCookie(header)) ?? []
    for (const cookie of setCookies) {
        if (!cookie.name || cookie.value === undefined) continue
        if (patterns.some((pattern) => pattern.test(cookie.name))) {
            selected[cookie.name] = cookie.value
        }
    }

    return Object.keys(selected).length > 0 ? selected : undefined
}
