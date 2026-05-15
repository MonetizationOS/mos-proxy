import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { PipelineContext } from '../context'
import { statusAllowsBody } from '../http'
import type { PageMetadata } from '../types'
import { registerLinkRewriteHandlers } from './linkRewriteHandlers'
import { streamingRegexRewriteBody } from './streamingRegexRewrite'
import { compileOriginLinkRewriterInternal } from './transformOriginLinks'

export interface LinkRewriteResult {
    response: Response
    /** Populated only on the htmlAware path; mutated as the body stream is drained. */
    pageMetadata: PageMetadata
}

export interface RewriteOptions {
    /** Opt in to the streaming HTML rewriter (attrs + script/style/template) with folded metadata extraction. */
    htmlAware?: boolean
}

export default function rewriteOriginResponse(
    ctx: PipelineContext,
    request: Request,
    response: Response,
    htmlRewriter: HtmlRewriterAdapter | null,
    options: RewriteOptions = {},
): LinkRewriteResult {
    const { logger, config } = ctx
    const pageMetadata: PageMetadata = {}

    const requestUrl = new URL(request.url)
    const originUrl = config.originUrl
    const compiled = compileOriginLinkRewriterInternal(requestUrl, originUrl)

    // Headers always get rewritten — a 302 redirect without a textual `Content-Type` still needs
    // its `Location` pointed at the proxy, and bare URLs in other headers (Link, Refresh, …)
    // would otherwise leak the origin host even when the body is passed through.
    const headers = new Headers()
    response.headers.forEach((value, name) => {
        try {
            headers.append(name, compiled.rewrite(value))
        } catch (error) {
            logger.log({
                level: 'error',
                code: 'link-rewriting-header-failed',
                message: 'Failed to rewrite origin link in response header; keeping original value.',
                context: { header: name },
                error,
            })
            headers.append(name, value)
        }
    })

    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers }

    // Passthrough: rewrite headers but never touch the body — applying `Cache-Control: no-store`
    // or re-streaming a binary/SRI-locked asset would defeat caching and break integrity.
    const contentType = response.headers.get('Content-Type') ?? ''
    const bodyStrategy = pickBodyStrategy(contentType)
    if (bodyStrategy === 'passthrough') {
        return { response: new Response(response.body, init), pageMetadata }
    }

    if (!statusAllowsBody(response.status) || !response.body) {
        return { response: new Response(null, init), pageMetadata }
    }

    headers.set('Cache-Control', 'no-store')
    headers.delete('Content-Length')
    headers.delete('Content-Encoding')

    if (bodyStrategy === 'html' && options.htmlAware && htmlRewriter) {
        const session = htmlRewriter.create()
        // Rewrite the captured `content` so `pageMetadata` matches what the default
        // `parsePageMetadata` path (which observes the rewritten body) would produce.
        session.on('meta', {
            element(element) {
                const key = element.getAttribute('name') ?? element.getAttribute('property')
                const value = element.getAttribute('content')
                if (key && value !== null) {
                    pageMetadata[key] = compiled.rewrite(value)
                }
            },
        })
        registerLinkRewriteHandlers(session, requestUrl, originUrl)
        const rewritten = session.transform(new Response(response.body, { status: response.status, headers: response.headers }))
        return { response: new Response(rewritten.body, init), pageMetadata }
    }

    return {
        response: new Response(response.body.pipeThrough(streamingRegexRewriteBody(compiled)), init),
        pageMetadata,
    }
}

type BodyStrategy = 'html' | 'text' | 'passthrough'

// CSS/JS are intentionally excluded: rewriting an external subresource body would invalidate any
// `integrity="…"` SRI hash referenced from the HTML, causing browsers to reject the asset.
function pickBodyStrategy(contentType: string): BodyStrategy {
    const ct = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html'
    if (ct === '') return 'passthrough'
    if (ct === 'text/css' || ct === 'text/javascript' || ct === 'text/ecmascript') return 'passthrough'
    if (ct === 'application/javascript' || ct === 'application/ecmascript') return 'passthrough'
    if (ct.startsWith('text/')) return 'text'
    if (ct === 'application/json' || ct.endsWith('+json')) return 'text'
    if (ct === 'application/xml' || ct.endsWith('+xml')) return 'text'
    return 'passthrough'
}
