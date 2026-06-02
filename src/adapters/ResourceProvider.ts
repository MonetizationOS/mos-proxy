import type { PageMetadata } from '../types'

/**
 * The resource the surface-decisions request is being made for. `id` defaults to the request
 * pathname and `meta` to the HTML-parsed page metadata; additional keys are passed through to the
 * MOS API untouched.
 */
export type Resource = {
    id: string
    meta?: PageMetadata
} & Record<string, unknown>

/**
 * Supplies extra per-request fields for the resource object sent to the surface-decisions API. The
 * returned record is merged over the proxy's derived defaults (`{ id: pathname, meta: pageMetadata }`),
 * so return only the keys you want to add or override — `id`/`meta` are preserved unless you set them:
 *
 * ```ts
 * const resourceProvider: ResourceProvider = {
 *     build: (request) => ({ tier: tierFromRequest(request) }),
 * }
 * ```
 *
 * Merging is shallow, matching `ClientMetadataProvider`.
 */
export interface ResourceProvider {
    build(request: Request): Partial<Resource> & Record<string, unknown>
}
