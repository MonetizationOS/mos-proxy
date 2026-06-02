import { type ClientMetadataProvider, defaultResolveIdentity, type Fetcher, type IdentityProvider } from '../adapters'
import { withMosProxyHeaders } from '../apiRequestHeaders'
import type { PipelineContext } from '../context'
import type { MosAuthenticatedApiRoute } from '../types'

export const handleMosAuthenticatedApiRoutes = async (
    request: Request,
    routes: MosAuthenticatedApiRoute[],
    ctx: PipelineContext,
    identityProvider: IdentityProvider | null,
    clientMetadataProvider: ClientMetadataProvider | null,
    apiFetcher: Fetcher | null,
): Promise<Response | null> => {
    if (!routes?.length) {
        return null
    }

    const url = new URL(request.url)
    for (const route of routes) {
        if (url.pathname === route.matchPath && request.method.toUpperCase() === route.method) {
            return handleMosAuthenticatedApiRoute(request, route, ctx, identityProvider, clientMetadataProvider, apiFetcher)
        }
    }

    return null
}

const handleMosAuthenticatedApiRoute = async (
    request: Request,
    route: MosAuthenticatedApiRoute,
    ctx: PipelineContext,
    identityProvider: IdentityProvider | null,
    clientMetadataProvider: ClientMetadataProvider | null,
    apiFetcher: Fetcher | null,
): Promise<Response | null> => {
    if (!apiFetcher) {
        throw new Error('MOSProxy: mosAuthenticatedApiRoutes are configured but no API fetcher is configured')
    }

    const { config, logger } = ctx
    const requestBody = await request.json()
    const identity = await (identityProvider?.resolve ?? defaultResolveIdentity)({ request, config, logger })

    return await apiFetcher(
        new Request(new URL(route.mosPath, config.mosHost), {
            method: route.method,
            body: JSON.stringify({
                ...requestBody,
                ...(clientMetadataProvider?.build(request) ?? {}),
                identity,
                http: { url: request.url, userAgent: request.headers.get('User-Agent') ?? undefined },
            }),
            headers: withMosProxyHeaders({
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.mosSecretKey}`,
            }),
        }),
    )
}
