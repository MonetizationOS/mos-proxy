import { type ClientMetadataProvider, defaultResolveIdentity, type IdentityProvider } from '../adapters'
import type { Fetcher } from '../adapters/Fetcher'
import { setMosProxyHeaders } from '../apiRequestHeaders'
import type { PipelineContext } from '../context'

export default async function customEndpointRequest(
    ctx: PipelineContext,
    request: Request,
    identityProvider: IdentityProvider | null,
    clientMetadataProvider: ClientMetadataProvider | null,
    apiFetcher: Fetcher,
): Promise<Response | null> {
    const { config, logger } = ctx
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

    const identity = await (identityProvider?.resolve ?? defaultResolveIdentity)({ request, config, logger })
    const clientMetadata = clientMetadataProvider?.build(request) ?? {}

    const apiRequest = new Request(target, request)
    setMosProxyHeaders(apiRequest.headers)
    apiRequest.headers.set('x-mos-key', `PublicBearer ${config.mosSecretKey}`)
    apiRequest.headers.set('x-mos-endpoint-request-context', JSON.stringify({ identity, clientMetadata }))
    return apiFetcher(apiRequest)
}
