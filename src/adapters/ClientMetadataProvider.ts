/**
 * Supplies platform-specific request metadata. The returned object is spread
 * into the surface-decisions request body at the top level, so each runtime
 * picks its own key — matching the shape the MOS API already accepts from the
 * platform-native workers.
 *
 * - Cloudflare: `{ cloudflare: { cf: request.cf } }`
 * - Fastly: `{ fastly: { client: event.client, sigsci: {...} } }`
 * - Akamai / unknown: `{}` is fine
 */
export interface ClientMetadataProvider {
    build(request: Request): Record<string, unknown>
}
