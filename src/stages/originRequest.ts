import type { Fetcher } from '../adapters/Fetcher'
import type { PipelineContext } from '../context'
import getTargetUrl from './getTargetUrl'

export default function performOriginRequest(ctx: PipelineContext, request: Request, originFetcher: Fetcher): Promise<Response> {
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

    return originFetcher(originRequest)
}
