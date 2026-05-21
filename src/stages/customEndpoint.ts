import type { Fetcher } from '../adapters/Fetcher'
import { setMosProxyHeaders } from '../apiRequestHeaders'
import type { PipelineContext } from '../context'

export default async function customEndpointRequest(ctx: PipelineContext, request: Request, apiFetcher: Fetcher): Promise<Response | null> {
    const { config } = ctx
    const requestUrl = new URL(request.url)
    const prefix = config.mosEndpointsPrefix

    if (!requestUrl.pathname.startsWith(prefix)) {
        return null
    }

    const target = new URL(request.url)
    target.protocol = config.mosHost.protocol
    target.host = config.mosHost.host
    target.port = config.mosHost.port
    target.pathname = `/api/v1/envs/${config.mosEnvironment}/endpoints/${requestUrl.pathname.slice(prefix.length).replace(/^\//, '')}`

    const apiRequest = new Request(target, request)
    setMosProxyHeaders(apiRequest.headers)
    return apiFetcher(apiRequest)
}
