import type { Fetcher } from '../../src/adapters/Fetcher'

export type FetchInvocation = { request: Request }

export type MockFetcher = Fetcher & { calls: FetchInvocation[] }

/**
 * Fake fetcher that records calls and returns responses produced by a user-supplied handler.
 * Use one instance per adapter role (origin vs. API) to keep assertions separated.
 */
export function MockFetcher(handler: (request: Request) => Response | Promise<Response>): MockFetcher {
    const calls: FetchInvocation[] = []
    const fetcher = async (request: Request): Promise<Response> => {
        calls.push({ request })
        return await handler(request)
    }
    return Object.assign(fetcher, { calls })
}
