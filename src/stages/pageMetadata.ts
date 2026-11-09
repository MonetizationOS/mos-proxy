import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { PageMetadata } from '../types'

/** Stop reading pages with no `<body>` after about this many bytes. */
export const PAGE_METADATA_MAX_BYTES = 1024 * 1024

/**
 * Reads `<meta>` tags up to `<body>`, then cancels `response.body`. Stops at `<body>` rather than `</head>` so a
 * `<meta>` between the two counts, as browsers treat it, and every rewriter stops in the same place. A page with no
 * `<body>` is read to the end of the chunk that reaches `maxBytes`.
 */
export async function parsePageMetadata(
    ctx: HtmlStageContext,
    response: Response,
    rewriter: HtmlRewriterAdapter,
    maxBytes = PAGE_METADATA_MAX_BYTES,
): Promise<PageMetadata> {
    const metadata: PageMetadata = {}
    if (!response.body) {
        return metadata
    }

    const closed = Promise.withResolvers<null>()
    let isClosed = false
    let inBody = false

    const reader = response.body.getReader()
    let bytesRead = 0
    const input = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const next = isClosed ? null : await Promise.race([reader.read(), closed.promise])
            if (!next || next.done || isClosed) {
                controller.close()
                // Not awaited: cancelling a tee branch waits for the other branch.
                reader.cancel().catch(() => {})
                return
            }
            controller.enqueue(next.value)
            bytesRead += next.value.byteLength
            if (bytesRead >= maxBytes) {
                isClosed = true
                closed.resolve(null)
            }
        },
        async cancel(reason) {
            await reader.cancel(reason).catch(() => {})
        },
    })

    try {
        const session = rewriter
            .create()
            .on('meta', {
                element(element) {
                    if (inBody) return
                    const key = element.getAttribute('name') ?? element.getAttribute('property')
                    const value = element.getAttribute('content')
                    if (key && value !== null) {
                        metadata[key] = value
                    }
                },
            })
            .on('body', {
                element() {
                    inBody = true
                    isClosed = true
                    closed.resolve(null)
                },
            })
        await session.transform(new Response(input, response)).text()
    } catch (error) {
        ctx.logger.log({
            level: 'error',
            code: 'page-metadata-parse-failed',
            message: 'Failed to parse page metadata; returning empty metadata.',
            error,
        })
    } finally {
        reader.cancel().catch(() => {})
    }

    return metadata
}
