/**
 * Dispatches an outbound HTTP request and returns its response.
 *
 * Used for both origin and MOS API traffic. Defaults to `globalThis.fetch`; override on
 * runtimes that need a backend binding or custom dispatch:
 * - Cloudflare: `fetch` (global fetch)
 * - Fastly: `(req) => fetch(req, { backend: 'origin' })` (separate backend per use)
 * - Akamai: wrap `httpRequest()` so surrounding code keeps talking web-standard `Request`/`Response`
 */
export type Fetcher = (request: Request) => Promise<Response>
