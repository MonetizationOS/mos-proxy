import type { Fetcher } from '../adapters/Fetcher'
import type { PipelineContext } from '../context'
import { isByteRangesContentType, isHtmlContentType, responseInit } from '../http'
import performOriginRequest from './originRequest'

// Enough for a boundary and one part's headers
const PART_HEADERS_LIMIT = 16 * 1024

/** The origin response as the HTML pipeline needs it: a whole page, never a range of one. */
export default async function fetchWholeHtml(
    ctx: PipelineContext,
    request: Request,
    originFetcher: Fetcher,
    response: Response,
): Promise<Response> {
    const whole = await refetchPartialHtml(ctx, request, originFetcher, response)
    const { headers } = whole
    const hasRanges = headers.has('Accept-Ranges') || headers.has('Content-Range')
    if (!isHtmlContentType(headers.get('Content-Type')) || !hasRanges) {
        return whole
    }

    // The served page is transformed, so its byte ranges aren't the origin's
    const served = new Headers(headers)
    served.delete('Accept-Ranges')
    served.delete('Content-Range')
    return new Response(whole.body, responseInit(whole, served))
}

async function refetchPartialHtml(ctx: PipelineContext, request: Request, originFetcher: Fetcher, response: Response): Promise<Response> {
    if (response.status !== 206 || (request.method !== 'GET' && request.method !== 'HEAD')) {
        return response
    }

    const contentType = response.headers.get('Content-Type')
    let partial = response
    let isHtml = isHtmlContentType(contentType)
    if (!isHtml && isByteRangesContentType(contentType) && response.body) {
        const peeked = await peekFirstPart(response, contentType as string)
        partial = peeked.response
        // A part whose headers can't be read might be HTML
        isHtml = !peeked.headers || isHtmlContentType(partContentType(peeked.headers))
    }
    if (!isHtml) {
        return partial
    }

    partial.body?.cancel().catch(() => {})
    return performOriginRequest(ctx, request, originFetcher, { ignoreRange: true })
}

/** Reads a multipart/byteranges body up to its first part's headers, null if they can't be read. Every part has the same type. */
async function peekFirstPart(response: Response, contentType: string): Promise<{ response: Response; headers: string[] | null }> {
    const boundary = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType)
    if (!boundary) {
        return { response, headers: null }
    }
    const delimiter = `--${boundary[1] ?? boundary[2]}`

    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('latin1')
    const chunks: Uint8Array[] = []
    let text = ''
    let headers: string[] | null = null
    try {
        while (!headers && text.length < PART_HEADERS_LIMIT) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            chunks.push(value)
            text += decoder.decode(value, { stream: true })
            headers = firstPartHeaders(text, delimiter)
        }
    } catch {
        return { response: new Response(null, responseInit(response)), headers: null }
    }

    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk)
            }
        },
        async pull(controller) {
            const { done, value } = await reader.read()
            if (done) {
                controller.close()
            } else {
                controller.enqueue(value)
            }
        },
        cancel(reason) {
            return reader.cancel(reason)
        },
    })
    return { response: new Response(body, responseInit(response)), headers }
}

/** A line that starts with whitespace continues the header before it. */
const unfold = (lines: string[]) =>
    lines.reduce<string[]>((headers, line) => {
        if (/^[ \t]/.test(line) && headers.length > 0) {
            headers[headers.length - 1] += ` ${line.trim()}`
        } else {
            headers.push(line)
        }
        return headers
    }, [])

const firstPartHeaders = (text: string, delimiter: string): string[] | null => {
    // Every line but the last has ended. A delimiter line may end in whitespace.
    const lines = text
        .split('\n')
        .slice(0, -1)
        .map((line) => line.trimEnd())
    const start = lines.indexOf(delimiter)
    const end = start === -1 ? -1 : lines.indexOf('', start + 1)
    return end === -1 ? null : lines.slice(start + 1, end)
}

const partContentType = (headers: string[]) =>
    unfold(headers)
        .find((header) => /^content-type:/i.test(header))
        ?.slice('content-type:'.length)
        .trim()
