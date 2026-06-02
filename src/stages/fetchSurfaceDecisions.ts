import type { Fetcher } from '../adapters/Fetcher'
import type { Identity } from '../adapters/IdentityProvider'
import { withMosProxyHeaders } from '../apiRequestHeaders'
import type { PipelineContext } from '../context'
import type { PageMetadata, SurfaceDecisionError, SurfaceDecisionResponse } from '../types'

export type FetchSurfaceDecisionsArgs = {
    identity: Identity
    path: string
    url: string
    clientMetadata: Record<string, unknown>
    pageMetadata?: PageMetadata
    userAgent?: string | undefined
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
    { identity, path, url, clientMetadata, pageMetadata, userAgent, originStatus }: FetchSurfaceDecisionsArgs,
    apiFetcher: Fetcher,
): Promise<FetchSurfaceDecisionsResult> {
    const { config } = ctx
    const body = JSON.stringify({
        ...clientMetadata,
        surfaceSlug: config.surfaceSlug,
        identity,
        resource: {
            id: path,
            meta: pageMetadata,
        },
        http: {
            url,
            userAgent,
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
