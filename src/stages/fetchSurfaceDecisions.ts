import type { Fetcher } from '../adapters/Fetcher'
import type { Identity } from '../adapters/IdentityProvider'
import type { Resource } from '../adapters/ResourceProvider'
import { withMosProxyHeaders } from '../apiRequestHeaders'
import type { PipelineContext } from '../context'
import type { SurfaceDecisionError, SurfaceDecisionResponse } from '../types'

export type FetchSurfaceDecisionsArgs = {
    identity: Identity
    url: string
    clientMetadata: Record<string, unknown>
    resource: Resource
    userAgent?: string | undefined
    referer?: string | undefined
    cookies?: Record<string, string> | undefined
    originStatus: number
}

export type FetchSurfaceDecisionsFailureReason = 'request-failed' | 'invalid-json' | 'api-error' | 'http-error' | 'invalid-response'

export type FetchSurfaceDecisionsResult =
    | {
          ok: true
          data: SurfaceDecisionResponse
      }
    | {
          ok: false
          reason: FetchSurfaceDecisionsFailureReason
          error: unknown
          status?: number
          statusCode?: number
      }

export default async function fetchSurfaceDecisions(
    ctx: PipelineContext,
    { identity, url, clientMetadata, resource, userAgent, referer, cookies, originStatus }: FetchSurfaceDecisionsArgs,
    apiFetcher: Fetcher,
): Promise<FetchSurfaceDecisionsResult> {
    const { config } = ctx
    const body = JSON.stringify({
        ...clientMetadata,
        surfaceSlug: config.surfaceSlug,
        identity,
        resource,
        http: {
            url,
            userAgent,
            referer,
            cookies,
            proxyOrigin: {
                status: originStatus,
            },
        },
    })

    const request = new Request(new URL('/api/v1/surface-decisions', config.mosHost), {
        method: 'POST',
        body,
        headers: withMosProxyHeaders({
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.mosSecretKey}`,
        }),
    })

    let response: Response
    try {
        response = await apiFetcher(request)
    } catch (error) {
        return { ok: false, reason: 'request-failed', error }
    }

    let data: unknown
    try {
        data = await response.json()
    } catch (error) {
        return { ok: false, reason: 'invalid-json', error, status: response.status }
    }

    if (isSurfaceDecisionError(data)) {
        return {
            ok: false,
            reason: 'api-error',
            error: new Error(data.message),
            status: response.status,
            statusCode: data.statusCode,
        }
    }

    if (!response.ok) {
        return {
            ok: false,
            reason: 'http-error',
            error: new Error(`Surface decisions API returned HTTP ${response.status}`),
            status: response.status,
        }
    }

    if (!isSurfaceDecisionResponse(data)) {
        return {
            ok: false,
            reason: 'invalid-response',
            error: new Error('Surface decisions API returned an invalid response shape'),
            status: response.status,
        }
    }

    return { ok: true, data }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isSurfaceDecisionError = (value: unknown): value is SurfaceDecisionError =>
    isRecord(value) && value.status === 'error' && typeof value.message === 'string' && typeof value.statusCode === 'number'

const isSurfaceDecisionResponse = (value: unknown): value is SurfaceDecisionResponse =>
    isRecord(value) &&
    value.status === 'success' &&
    isRecord(value.identity) &&
    isRecord(value.features) &&
    isRecord(value.customer) &&
    isRecord(value.surfaceBehavior) &&
    typeof value.componentsSkipped === 'boolean' &&
    isRecord(value.componentBehaviors)
