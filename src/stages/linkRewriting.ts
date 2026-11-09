import type { PipelineContext } from '../context'
import { statusAllowsBody } from '../http'
import compileOriginLinkRewriter, { createOriginLinkStreamRewriter, type OriginLinkStreamRewriter } from './originLinkRewriter'

/** Rewrites origin links in headers and, streaming, in the body. */
export default async function rewriteOriginResponse(ctx: PipelineContext, request: Request, response: Response): Promise<Response> {
    const { config, logger } = ctx
    const requestUrl = new URL(request.url)
    const originUrl = config.originUrl
    const originLinkRewriter = compileOriginLinkRewriter(requestUrl, originUrl)

    const headers = new Headers()
    response.headers.forEach((value, name) => {
        try {
            headers.append(name, originLinkRewriter(value))
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
    headers.set('Cache-Control', 'no-store')

    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers }

    if (!statusAllowsBody(response.status) || !response.body) {
        return new Response(null, init)
    }

    // Mutating the body invalidates the origin's byte-length/encoding metadata.
    headers.delete('Content-Length')
    headers.delete('Content-Encoding')

    const reader = response.body.getReader()
    const body = rewriteBody(reader, createOriginLinkStreamRewriter(requestUrl, originUrl))
    // Read up to the first output so an empty body stays a null body.
    const first = await body.next()
    if (first.done) {
        return new Response(null, init)
    }

    const encoder = new TextEncoder()
    let next: IteratorResult<string> | null = first
    return new Response(
        new ReadableStream<Uint8Array>({
            async pull(controller) {
                const result = next ?? (await body.next())
                next = null
                if (result.done) {
                    controller.close()
                } else {
                    controller.enqueue(encoder.encode(result.value))
                }
            },
            async cancel(reason) {
                // Cancel the origin first: return() waits for a pending read.
                await reader.cancel(reason).catch(() => {})
                await body.return(undefined)
            },
        }),
        init,
    )
}

async function* rewriteBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    rewriter: OriginLinkStreamRewriter,
): AsyncGenerator<string, void, unknown> {
    const decoder = new TextDecoder()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const output = rewriter.push(decoder.decode(value, { stream: true }))
            if (output) yield output
        }
        const output = rewriter.push(decoder.decode()) + rewriter.end()
        if (output) yield output
    } finally {
        await reader.cancel().catch(() => {})
    }
}
