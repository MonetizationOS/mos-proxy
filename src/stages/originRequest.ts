import type { Fetcher } from '../adapters/Fetcher'
import type { PipelineContext } from '../context'
import getTargetUrl from './getTargetUrl'

/** Which Range headers are passed to the origin. */
export type OriginRanges = 'any' | 'single' | 'none'

export default function performOriginRequest(
    ctx: PipelineContext,
    request: Request,
    originFetcher: Fetcher,
    ranges: OriginRanges = 'any',
): Promise<Response> {
    const viewerUrl = new URL(request.url)
    const targetUrl = getTargetUrl(viewerUrl, ctx.config.originUrl)
    const originRequest = new Request(targetUrl, request)

    // The origin is fetched on its own host, so pass it the viewer's. originRequestHeaders can override these.
    originRequest.headers.delete('Forwarded')
    originRequest.headers.set('X-Forwarded-Host', viewerUrl.host)
    originRequest.headers.set('X-Forwarded-Proto', viewerUrl.protocol.slice(0, -1))

    for (const [name, value] of Object.entries(ctx.config.originRequestHeaders)) {
        originRequest.headers.set(name, value)
    }

    // Ranges are only defined for GET. After originRequestHeaders, so config can't add one back.
    const isGet = request.method === 'GET' || request.method === 'HEAD'
    const severalRanges = originRequest.headers.get('Range')?.includes(',') ?? false
    if (!isGet || ranges === 'none' || (ranges === 'single' && severalRanges)) {
        originRequest.headers.delete('Range')
        originRequest.headers.delete('If-Range')
    }

    return originFetcher(originRequest)
}
