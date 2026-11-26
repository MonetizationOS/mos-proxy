import type { Fetcher } from '../adapters/Fetcher'
import type { PipelineContext } from '../context'
import { isHtmlContentType, responseInit } from '../http'
import performOriginRequest from './originRequest'

/**
 * The origin response as the HTML pipeline needs it: a whole page, never a range of one.
 * Requests for several ranges never reach the origin (see MOSProxy), so a partial page is a single range.
 */
export default async function fetchWholeHtml(
    ctx: PipelineContext,
    request: Request,
    originFetcher: Fetcher,
    response: Response,
): Promise<Response> {
    if (!isHtmlContentType(response.headers.get('Content-Type'))) {
        return response
    }

    let whole = response
    const isGet = request.method === 'GET' || request.method === 'HEAD'
    if (response.status === 206 && isGet) {
        response.body?.cancel().catch(() => {})
        whole = await performOriginRequest(ctx, request, originFetcher, 'none')
    }

    const { headers } = whole
    if (!isHtmlContentType(headers.get('Content-Type')) || !(headers.has('Accept-Ranges') || headers.has('Content-Range'))) {
        return whole
    }

    // The served page is transformed, so its byte ranges aren't the origin's
    const served = new Headers(headers)
    served.delete('Accept-Ranges')
    served.delete('Content-Range')
    return new Response(whole.body, responseInit(whole, served))
}
