import type { PipelineContext } from '../context'
import { statusAllowsBody } from '../http'
import transformOriginLinks from './transformOriginLinks'

export default async function rewriteOriginResponse(ctx: PipelineContext, request: Request, response: Response): Promise<Response> {
    const { config, logger } = ctx
    const requestUrl = new URL(request.url)
    const originUrl = config.originUrl

    const headers = new Headers()
    response.headers.forEach((value, name) => {
        try {
            headers.append(name, transformOriginLinks(requestUrl, originUrl, value))
        } catch (error) {
            logger.log({
                level: 'error',
                code: 'link-rewriting-header-failed',
                message: 'Failed to rewrite origin link in response header; keeping original value.',
                context: { header: name },
                error,
            })
            headers.append(name, value)
        }
    })
    headers.set('Cache-Control', 'no-store')

    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers }

    if (!statusAllowsBody(response.status) || !response.body) {
        return new Response(null, init)
    }

    // Mutating the body invalidates the origin's byte-length/encoding metadata.
    headers.delete('Content-Length')
    headers.delete('Content-Encoding')

    const body = await response.text()
    if (!body) {
        return new Response(null, init)
    }

    return new Response(transformOriginLinks(requestUrl, originUrl, body), init)
}
