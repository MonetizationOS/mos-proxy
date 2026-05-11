import type { Fetcher } from '../adapters/Fetcher'
import type { PipelineContext } from '../context'
import getTargetUrl from './getTargetUrl'

export default function performOriginRequest(ctx: PipelineContext, request: Request, originFetcher: Fetcher): Promise<Response> {
    const targetUrl = getTargetUrl(new URL(request.url), ctx.config.originUrl)
    const originRequest = new Request(targetUrl, request)

    for (const [name, value] of Object.entries(ctx.config.originRequestHeaders)) {
        originRequest.headers.set(name, value)
    }

    return originFetcher(originRequest)
}
