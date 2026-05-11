/**
 * Supplies platform-specific request metadata forwarded to the surface-decisions API
 * under the `cloudflare` field of the request payload (kept for backwards-compat;
 * future schema may rename).
 *
 * - Cloudflare: `{ cf: request.cf }`
 * - Fastly: `{ fastly: { client: event.client, sigsci: {...} } }`
 * - Akamai / unknown: `{}` is fine
 */
export interface ClientMetadataProvider {
    build(request: Request): Record<string, unknown>
}
