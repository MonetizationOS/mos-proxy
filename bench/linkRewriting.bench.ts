// Run with: pnpm bench

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RewriterElement, RewriterText } from '../src/adapters/HtmlRewriterAdapter'
import { normalizeMOSConfig } from '../src/config'
import type { PipelineContext } from '../src/context'
import { statusAllowsBody } from '../src/http'
import type { MOSProxyLogger } from '../src/logger'
import rewriteOriginResponse from '../src/stages/linkRewriting'
import transformOriginLinks from '../src/stages/transformOriginLinks'
import { LolHtmlRewriter } from '../test/fakes/LolHtmlRewriter'
import { buildFixture } from './generateFixture'

const CHUNK_SIZE = 16 * 1024
const ITERATIONS = 30
const WARMUP = 5
const TRIM_FRACTION = 0.1

const silentLogger: MOSProxyLogger = { log() {} }
const ctx: PipelineContext = {
    config: normalizeMOSConfig({
        originUrl: 'https://origin.example.com',
        surfaceSlug: 'web',
        mosHost: 'https://api.monetizationos.com',
        mosSecretKey: 'sk_env_test_abc',
        anonymousSessionCookieName: 'anon',
        authenticatedUserJwtCookieName: 'jwt',
    }),
    logger: silentLogger,
}
const request = new Request('https://proxy.example.com/article')

const ONE_STAR_ATTRS = [
    'href',
    'src',
    'srcset',
    'imagesrcset',
    'srcdoc',
    'action',
    'formaction',
    'poster',
    'cite',
    'data',
    'codebase',
    'archive',
    'ping',
    'usemap',
    'longdesc',
    'manifest',
    'content',
    'background',
    'style',
    'xlink:href',
    'itemid',
    'resource',
    'about',
    'data-src',
    'data-srcset',
    'data-href',
    'data-url',
    'data-poster',
    'data-bg',
    'data-background',
    'data-background-image',
    'data-image',
    'data-image-src',
    'data-original',
    'data-lazy',
    'data-lazy-src',
    'data-lazy-srcset',
    'data-thumb',
    'data-thumbnail',
] as const

const oneStarRewrite = async (req: Request, response: Response): Promise<Response> => {
    const requestUrl = new URL(req.url)
    const originUrl = ctx.config.originUrl
    const headers = new Headers()
    response.headers.forEach((value, name) => {
        headers.append(name, transformOriginLinks(requestUrl, originUrl, value))
    })
    headers.set('Cache-Control', 'no-store')
    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers }
    if (!statusAllowsBody(response.status) || !response.body) return new Response(null, init)
    headers.delete('Content-Length')
    headers.delete('Content-Encoding')

    const session = new LolHtmlRewriter().create()
    session.on('*', {
        element(el: RewriterElement) {
            for (const name of ONE_STAR_ATTRS) {
                const v = el.getAttribute(name)
                if (v === null) continue
                const next = transformOriginLinks(requestUrl, originUrl, v)
                if (next !== v) el.setAttribute(name, next)
            }
        },
    })
    let oneStarBuf = ''
    session.on('script, style, template', {
        element() {
            oneStarBuf = ''
        },
        text(t: RewriterText) {
            oneStarBuf += t.text
            if (t.lastInTextNode) {
                const out = transformOriginLinks(requestUrl, originUrl, oneStarBuf)
                oneStarBuf = ''
                t.replace(out, { html: false })
            } else {
                t.remove()
            }
        },
    })
    const rewritten = session.transform(new Response(response.body, { status: response.status, headers: response.headers }))
    return new Response(rewritten.body, init)
}

const regexRewrite = async (req: Request, response: Response): Promise<Response> => {
    const requestUrl = new URL(req.url)
    const originUrl = ctx.config.originUrl
    const headers = new Headers()
    response.headers.forEach((value, name) => {
        headers.append(name, transformOriginLinks(requestUrl, originUrl, value))
    })
    headers.set('Cache-Control', 'no-store')
    headers.delete('Content-Length')
    headers.delete('Content-Encoding')
    const body = await response.text()
    return new Response(transformOriginLinks(requestUrl, originUrl, body), {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

const streamingRegexRewrite = async (req: Request, response: Response): Promise<Response> => {
    const requestUrl = new URL(req.url)
    const originUrl = ctx.config.originUrl

    const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const originPort = originUrl.port ? `:${originUrl.port}` : ''
    const originBasePath = originUrl.pathname.replace(/\/$/, '')
    const originHostname = originUrl.hostname
    const regex = new RegExp(`(https?:)?//${escapeRegExp(`${originHostname}${originPort}${originBasePath}`)}`, 'g')
    const requestPort = requestUrl.port ? `:${requestUrl.port}` : ''
    const replacement = `${requestUrl.protocol}//${requestUrl.hostname}${requestPort}`
    const maxMatch = 'https://'.length + originHostname.length + originPort.length + originBasePath.length
    const rewrite = (s: string) => (s.includes(originHostname) ? s.replace(regex, replacement) : s)

    const headers = new Headers()
    response.headers.forEach((value, name) => {
        headers.append(name, rewrite(value))
    })
    headers.set('Cache-Control', 'no-store')
    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers }
    if (!statusAllowsBody(response.status) || !response.body) return new Response(null, init)
    headers.delete('Content-Length')
    headers.delete('Content-Encoding')

    const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
            if (!response.body) {
                controller.close()
                return
            }
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            const encoder = new TextEncoder()
            let pending = ''

            const flush = (final: boolean) => {
                if (pending.length === 0) return
                let cut: number
                if (final) {
                    cut = pending.length
                } else if (pending.length <= maxMatch) {
                    return
                } else {
                    cut = pending.length - maxMatch
                    regex.lastIndex = Math.max(0, cut - maxMatch + 1)
                    let m: RegExpExecArray | null
                    while ((m = regex.exec(pending)) !== null) {
                        if (m.index >= cut) break
                        const mEnd = m.index + m[0].length
                        if (mEnd > cut) cut = mEnd
                    }
                    regex.lastIndex = 0
                }
                const safe = pending.slice(0, cut)
                pending = pending.slice(cut)
                controller.enqueue(encoder.encode(rewrite(safe)))
            }

            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    pending += decoder.decode(value, { stream: true })
                    flush(false)
                }
                pending += decoder.decode()
                flush(true)
                controller.close()
            } catch (error) {
                controller.error(error)
            }
        },
    })
    return new Response(stream, init)
}

const chunkedResponse = (body: Uint8Array): Response => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let i = 0; i < body.length; i += CHUNK_SIZE) {
                controller.enqueue(body.subarray(i, i + CHUNK_SIZE))
            }
            controller.close()
        },
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/html' } })
}

interface Sample {
    totalMs: number
    ttfbMs: number
    rssDeltaMB: number
    outputBytes: number
}

const measure = async (run: () => Promise<Response>): Promise<Sample> => {
    if (global.gc) global.gc()
    const rssBefore = process.memoryUsage().rss
    const t0 = performance.now()
    const res = await run()
    if (!res.body) throw new Error('measure: response has no body')
    const reader = res.body.getReader()
    let ttfb = -1
    let bytes = 0
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (ttfb < 0) ttfb = performance.now() - t0
        bytes += value.byteLength
    }
    const total = performance.now() - t0
    const rssAfter = process.memoryUsage().rss
    return {
        totalMs: total,
        ttfbMs: ttfb < 0 ? total : ttfb,
        rssDeltaMB: (rssAfter - rssBefore) / 1024 / 1024,
        outputBytes: bytes,
    }
}

const benchOne = async (label: string, run: () => Promise<Response>): Promise<Sample[]> => {
    for (let i = 0; i < WARMUP; i++) await measure(run)
    const samples: Sample[] = []
    for (let i = 0; i < ITERATIONS; i++) samples.push(await measure(run))
    console.log(`  ${label}: done (${samples.length} samples)`)
    return samples
}

const pct = (xs: number[], p: number) => {
    const sorted = [...xs].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

const fmt = (n: number, digits = 1) => n.toFixed(digits)

const runFixture = async (label: string, bytes: Uint8Array) => {
    console.log(
        `\n${label}: ${(bytes.length / 1024).toFixed(1)} KB, ${CHUNK_SIZE / 1024}KB chunks, ${ITERATIONS} iters (+${WARMUP} warmup)`,
    )

    const runs = {
        'htmlAware (lol-html)': () =>
            Promise.resolve(
                rewriteOriginResponse(ctx, request, chunkedResponse(bytes), new LolHtmlRewriter(), { htmlAware: true }).response,
            ),
        'default (streaming-regex)': () =>
            Promise.resolve(rewriteOriginResponse(ctx, request, chunkedResponse(bytes), new LolHtmlRewriter()).response),
        'one-star (probe-all)': () => oneStarRewrite(request, chunkedResponse(bytes)),
        'streaming-regex (inline)': () => streamingRegexRewrite(request, chunkedResponse(bytes)),
        'regex (buffered)': () => regexRewrite(request, chunkedResponse(bytes)),
    }

    const results: Record<string, Sample[]> = {}
    for (const [runLabel, fn] of Object.entries(runs)) {
        results[runLabel] = await benchOne(runLabel, fn)
    }

    const trim = (xs: number[]): number[] => {
        const sorted = [...xs].sort((a, b) => a - b)
        const drop = Math.floor(sorted.length * TRIM_FRACTION)
        return sorted.slice(drop, sorted.length - drop)
    }

    console.log(`\n================ RESULTS (${label}) ================`)
    console.log(`(${ITERATIONS} iters, ${WARMUP} warmup, trimmed ${(TRIM_FRACTION * 100).toFixed(0)}% top/bottom)`)
    console.log('Mode                       | total mean | total p50 | total p95 | TTFB mean | TTFB p50 | output bytes')
    console.log('---------------------------|------------|-----------|-----------|-----------|----------|-------------')
    for (const [runLabel, samples] of Object.entries(results)) {
        const tot = trim(samples.map((s) => s.totalMs))
        const ttfb = trim(samples.map((s) => s.ttfbMs))
        console.log(
            `${runLabel.padEnd(26)} | ${fmt(mean(tot)).padStart(7)} ms | ${fmt(pct(tot, 0.5)).padStart(6)} ms | ${fmt(pct(tot, 0.95)).padStart(6)} ms | ${fmt(mean(ttfb)).padStart(6)} ms | ${fmt(pct(ttfb, 0.5)).padStart(5)} ms | ${samples[0].outputBytes}`,
        )
    }
    console.log('====================================================\n')
}

const main = async () => {
    const synthBytes = new TextEncoder().encode(buildFixture())
    await runFixture('Synthetic 2MB', synthBytes)

    const sampleHtml = readFileSync(fileURLToPath(new URL('./fixtures/sample-page.html', import.meta.url)), 'utf-8')
    await runFixture('sample-page (~57 KB)', new TextEncoder().encode(sampleHtml))
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
