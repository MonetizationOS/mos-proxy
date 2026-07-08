import { describe, expect, it } from 'vitest'
import type { ConfigFactory, UnresolvedConfigHandler } from '../src/adapters/ConfigFactory'
import { ConfigResolution, ConfigUnresolvableError } from '../src/configResolution'
import type { MOSConfigInput } from '../src/types'
import { createMemoryLogger } from './fakes/MemoryLogger'

const input = (overrides: Partial<MOSConfigInput> = {}): MOSConfigInput => ({
    originUrl: 'https://origin.example.com',
    surfaceSlug: 'web',
    mosHost: 'https://api.monetizationos.com',
    mosSecretKey: 'sk_env_test',
    anonymousSessionCookieName: 'anon-session',
    authenticatedUserJwtCookieName: '__session',
    ...overrides,
})

const make = (source: MOSConfigInput | ConfigFactory, opts: { onUnresolved?: UnresolvedConfigHandler; maxCachedConfigs?: number } = {}) => {
    const { events, logger } = createMemoryLogger()
    const resolution = new ConfigResolution({
        input: source,
        onUnresolved: opts.onUnresolved ?? null,
        maxCachedConfigs: opts.maxCachedConfigs ?? 256,
        logger,
    })
    return { resolution, events }
}

const req = (url: string) => new Request(url)
const expectConfig = (result: Awaited<ReturnType<ConfigResolution['resolve']>>) => {
    if (result instanceof Response) throw new Error('expected a config, got a Response')
    return result
}
const expectResponse = (result: Awaited<ReturnType<ConfigResolution['resolve']>>): Response => {
    if (!(result instanceof Response)) throw new Error('expected a Response, got a config')
    return result
}

describe('ConfigResolution', () => {
    describe('maxCachedConfigs validation', () => {
        for (const size of [0, -1, 1.5, Number.NaN]) {
            it(`throws at construction when maxCachedConfigs is ${size}`, () => {
                expect(() => make(input(), { maxCachedConfigs: size })).toThrow(/maxCachedConfigs must be a positive integer/)
            })
        }

        it('accepts a positive integer', () => {
            expect(() => make(input(), { maxCachedConfigs: 1 })).not.toThrow()
        })
    })

    describe('static config', () => {
        it('normalizes once up front and returns the same instance for every request', async () => {
            const { resolution } = make(input())
            const a = await resolution.resolve(req('https://acme.com/1'))
            const b = await resolution.resolve(req('https://acme.com/2'))
            expect(a).toBe(b)
            expect(expectConfig(a).originUrl).toBeInstanceOf(URL)
        })
    })

    describe('factory config', () => {
        it('normalizes the returned config and derives fields (URL, mosEnvironment)', async () => {
            const { resolution } = make(() => input({ mosSecretKey: 'sk_prod_xyz' }))
            const cfg = expectConfig(await resolution.resolve(req('https://acme.com/x')))
            expect(cfg.originUrl).toBeInstanceOf(URL)
            expect(cfg.mosEnvironment).toBe('prod_xyz')
        })

        it('awaits an async factory', async () => {
            const factory: ConfigFactory = async () => {
                await Promise.resolve()
                return input({ surfaceSlug: 'async' })
            }
            const cfg = expectConfig(await make(factory).resolution.resolve(req('https://acme.com/x')))
            expect(cfg.surfaceSlug).toBe('async')
        })

        it('memoizes by content so an invalid regex warns once across identical returns', async () => {
            const { resolution, events } = make(() => input({ surfaceDecisionsIgnorePaths: '[invalid' }))
            await resolution.resolve(req('https://acme.com/x'))
            await resolution.resolve(req('https://acme.com/y'))
            expect(events.filter((e) => e.code === 'invalid-ignore-path-pattern')).toHaveLength(1)
        })
    })

    describe('fail-over', () => {
        it('throws ConfigUnresolvableError when the factory throws and nothing can be served', async () => {
            const { resolution, events } = make(() => {
                throw new Error('boom')
            })
            await expect(resolution.resolve(req('https://acme.com/x'))).rejects.toBeInstanceOf(ConfigUnresolvableError)
            expect(events.filter((e) => e.code === 'config-resolution-failed')).toHaveLength(1)
        })

        it('throws ConfigUnresolvableError when the returned config cannot be normalized', async () => {
            const { resolution } = make(() => input({ originUrl: 'not-a-url' }))
            await expect(resolution.resolve(req('https://acme.com/x'))).rejects.toBeInstanceOf(ConfigUnresolvableError)
        })

        it('logs a throwing factory every time, but an un-normalizable config only once (negative cache)', async () => {
            const throwing = make(() => {
                throw new Error('boom')
            })
            for (let i = 0; i < 3; i++) await throwing.resolution.resolve(req('https://acme.com/x')).catch(() => {})
            expect(throwing.events.filter((e) => e.code === 'config-resolution-failed')).toHaveLength(3)

            const invalid = make(() => input({ originUrl: 'not-a-url' }))
            for (let i = 0; i < 3; i++) await invalid.resolution.resolve(req('https://acme.com/x')).catch(() => {})
            expect(invalid.events.filter((e) => e.code === 'config-resolution-failed')).toHaveLength(1)
        })

        it('passes the original normalization error to the handler on every call, including negative-cache hits', async () => {
            const seen: unknown[] = []
            const { resolution } = make(() => input({ originUrl: 'not-a-url' }), {
                onUnresolved: ({ error }) => {
                    seen.push(error)
                    return new Response('closed', { status: 404 })
                },
            })
            await resolution.resolve(req('https://acme.com/x')) // normalize throws: error passed through
            await resolution.resolve(req('https://acme.com/y')) // negative-cache hit: same error, not undefined
            expect(seen).toHaveLength(2)
            expect(seen[0]).toBeInstanceOf(Error)
            expect(seen[1]).toBe(seen[0])
        })

        it('serves the last-known-good config for the host after a later failure', async () => {
            let healthy = true
            const { resolution, events } = make(() => {
                if (!healthy) throw new Error('store down')
                return input({ surfaceSlug: 'good' })
            })
            expect(expectConfig(await resolution.resolve(req('https://acme.com/x'))).surfaceSlug).toBe('good')

            healthy = false
            const fallback = expectConfig(await resolution.resolve(req('https://acme.com/y')))
            expect(fallback.surfaceSlug).toBe('good')
            expect(events.filter((e) => e.code === 'config-resolution-served-last-known-good')).toHaveLength(1)
        })

        it("never serves another host's last-known-good config", async () => {
            const { resolution } = make((request) => {
                const host = new URL(request.url).hostname
                if (host === 'good.com') return input({ surfaceSlug: 'good' })
                throw new Error(`no config for ${host}`)
            })
            await resolution.resolve(req('https://good.com/x'))
            // bad.com has no last-known-good of its own — it must throw, not borrow good.com's.
            await expect(resolution.resolve(req('https://bad.com/x'))).rejects.toBeInstanceOf(ConfigUnresolvableError)
        })

        it('returns the handler Response (fail closed) before any last-known-good fallback', async () => {
            const { resolution } = make(
                () => {
                    throw new Error('boom')
                },
                { onUnresolved: ({ reason }) => new Response(`closed:${reason}`, { status: 404 }) },
            )
            const res = expectResponse(await resolution.resolve(req('https://acme.com/x')))
            expect(res.status).toBe(404)
            expect(await res.text()).toBe('closed:invalid-config')
        })

        it('falls through to last-known-good when the handler returns nothing', async () => {
            let healthy = true
            const { resolution } = make(
                () => {
                    if (!healthy) throw new Error('boom')
                    return input({ surfaceSlug: 'good' })
                },
                { onUnresolved: () => undefined },
            )
            await resolution.resolve(req('https://acme.com/x'))
            healthy = false
            expect(expectConfig(await resolution.resolve(req('https://acme.com/y'))).surfaceSlug).toBe('good')
        })

        it('falls through and logs when the handler throws', async () => {
            let healthy = true
            const { resolution, events } = make(
                () => {
                    if (!healthy) throw new Error('boom')
                    return input({ surfaceSlug: 'good' })
                },
                {
                    onUnresolved: () => {
                        throw new Error('handler boom')
                    },
                },
            )
            await resolution.resolve(req('https://acme.com/x'))
            healthy = false
            await resolution.resolve(req('https://acme.com/y'))
            expect(events.filter((e) => e.code === 'unresolved-config-handler-threw')).toHaveLength(1)
        })
    })
})
