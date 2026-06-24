import type { ConfigFactory } from './adapters/ConfigFactory'
import type { MOSConfigInput } from './types'

/** Non-optional keys of `T`. */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]
/** Required config keys not supplied by base `B`. */
type MissingRequiredConfigKeys<B> = Exclude<RequiredKeys<MOSConfigInput>, keyof B>
/** Rule config: the required keys `base` lacks, plus any other field optionally. */
type RuleConfig<B> = Partial<MOSConfigInput> & Required<Pick<MOSConfigInput, MissingRequiredConfigKeys<B>>>

/** A host/path → config rule for {@link hostPathMatcher}. */
export interface HostPathRule<B = Record<never, never>> {
    /** Exact request hostname (case-insensitive, port-free, no wildcards). Omit to match any host. */
    host?: string
    /** Path prefix, matched on segment boundaries (`/news` matches `/news/x`, not `/newsletter`). Omit, or pass `/`, for any path. */
    pathPrefix?: string
    /** This rule's config, shallow-merged over `base`. Must contain every required field `base` lacks. */
    config: RuleConfig<B>
}

interface CompiledRule {
    host: string | undefined
    prefix: string | undefined
    config: Partial<MOSConfigInput>
}

function normalizePrefix(pathPrefix: string | undefined): string | undefined {
    if (pathPrefix === undefined) {
        return undefined
    }
    const trimmed = pathPrefix.replace(/^\/+/, '').replace(/\/+$/, '')
    return trimmed === '' ? undefined : `/${trimmed}`
}

/** Whether `prefix` matches `pathname`: absent, equal, or on a segment boundary. */
function prefixMatches(prefix: string | undefined, pathname: string): boolean {
    return prefix === undefined || pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** Best `eligible` rule by longest matching prefix; ties go to the first declared. */
function selectBestRule(rules: CompiledRule[], pathname: string, eligible: (rule: CompiledRule) => boolean): CompiledRule | undefined {
    let best: CompiledRule | undefined
    let bestPrefixLength = -1
    for (const rule of rules) {
        if (!eligible(rule) || !prefixMatches(rule.prefix, pathname)) {
            continue
        }
        const prefixLength = rule.prefix === undefined ? 0 : rule.prefix.length
        // Strict > keeps the first rule on a tie.
        if (best === undefined || prefixLength > bestPrefixLength) {
            best = rule
            bestPrefixLength = prefixLength
        }
    }
    return best
}

/**
 * Builds a {@link ConfigFactory} from host/path rules. Each rule's `config` is shallow-merged over
 * `base`; the result must be a complete {@link MOSConfigInput}.
 *
 * Resolution order — the first match wins:
 * 1. Rules whose `host` is the request host, longest matching `pathPrefix` first (ties: earlier rule).
 * 2. Host-less rules, ranked the same way; one with no `pathPrefix` is the global catch-all (at most one).
 * 3. No match throws.
 *
 * `config` is type-checked to supply the keys `base` lacks, but only when `base` is written
 * `satisfies Partial<MOSConfigInput>` (not annotated). `normalizeMOSConfig` re-checks at runtime.
 */
export function hostPathMatcher<const B extends Partial<MOSConfigInput> = Record<never, never>>(
    rules: HostPathRule<B>[],
    base?: B,
): ConfigFactory {
    const compiled: CompiledRule[] = rules.map((rule) => ({
        host: rule.host?.toLowerCase(),
        prefix: normalizePrefix(rule.pathPrefix),
        config: rule.config,
    }))

    const globalCatchAlls = compiled.filter((rule) => rule.host === undefined && rule.prefix === undefined)
    if (globalCatchAlls.length > 1) {
        throw new Error('hostPathMatcher: only one host-less, path-less global catch-all rule is allowed')
    }

    return (request) => {
        const url = new URL(request.url)
        // hostname is port-free; url.host would keep the port (acme.com:8443).
        const host = url.hostname
        const pathname = url.pathname

        // Host tier wins over host-less.
        const matchedRule =
            selectBestRule(compiled, pathname, (rule) => rule.host === host) ??
            selectBestRule(compiled, pathname, (rule) => rule.host === undefined)
        if (matchedRule === undefined) {
            throw new Error(`hostPathMatcher: no rule matched ${host}${pathname}`)
        }

        return { ...base, ...matchedRule.config } as MOSConfigInput
    }
}
