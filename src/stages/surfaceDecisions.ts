import type { ClientMetadataProvider } from '../adapters/ClientMetadataProvider'
import type { Fetcher } from '../adapters/Fetcher'
import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import { defaultPersistIdentity, defaultResolveIdentity, type Identity, type IdentityProvider } from '../adapters/IdentityProvider'
import type { ResourceProvider } from '../adapters/ResourceProvider'
import type { PipelineContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import fetchSurfaceDecisions from './fetchSurfaceDecisions'
import { parsePageMetadata } from './pageMetadata'

export default async function getSurfaceDecisions(
    ctx: PipelineContext,
    request: Request,
    response: Response,
    apiFetcher: Fetcher,
    rewriter: HtmlRewriterAdapter | null,
    clientMetadataProvider: ClientMetadataProvider | null,
    identityProvider: IdentityProvider | null,
    resourceProvider: ResourceProvider | null,
): Promise<[Response, SurfaceDecisionResponse | null]> {
    const { config, logger } = ctx

    const resolve = identityProvider?.resolve ?? defaultResolveIdentity
    let identity: Identity
    try {
        identity = await resolve({ request, originResponse: response, config, logger })
    } catch (error) {
        logger.log({
            level: 'warn',
            code: 'identity-resolve-failed',
            message: 'Identity provider resolve threw; skipping surface decisions and returning origin response.',
            error,
        })
        return [response, null]
    }

    const [metadataStream, passThroughStream] = response.body?.tee() ?? [null, null]
    const pageMetadata = metadataStream && rewriter ? await parsePageMetadata(ctx, new Response(metadataStream, response), rewriter) : {}
    let modifiedResponse = passThroughStream ? new Response(passThroughStream, response) : response

    const clientMetadata = clientMetadataProvider?.build(request) ?? {}

    const resource = { id: new URL(request.url).pathname, meta: pageMetadata, ...resourceProvider?.build(request) }

    const result = await fetchSurfaceDecisions(
        ctx,
        {
            identity,
            url: request.url,
            clientMetadata,
            resource,
            userAgent: request.headers.get('User-Agent') ?? undefined,
            referer: request.headers.get('Referer') ?? undefined,
            originStatus: response.status,
        },
        apiFetcher,
    )

    if (!result.ok) {
        logger.log({
            level: 'warn',
            code: 'surface-decisions-api-failed',
            message: 'Surface decisions API failed; continuing with the origin response.',
            context: {
                reason: result.reason,
                status: result.status,
                statusCode: result.statusCode,
            },
            error: result.error,
        })
        return [modifiedResponse, null]
    }

    const surfaceDecisions = result.data

    const persist = identityProvider?.persist ?? defaultPersistIdentity
    try {
        modifiedResponse = await persist({
            resolved: identity,
            decisions: surfaceDecisions,
            response: modifiedResponse,
            request,
            config,
            logger,
        })
    } catch (error) {
        logger.log({
            level: 'warn',
            code: 'identity-persist-failed',
            message: 'Identity provider persist threw; keeping pre-persist response.',
            error,
        })
    }

    return [modifiedResponse, surfaceDecisions]
}
