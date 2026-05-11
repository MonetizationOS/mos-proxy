import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { PipelineContext } from '../context'
import type { PageMetadata } from '../types'

export async function parsePageMetadata(ctx: PipelineContext, response: Response, rewriter: HtmlRewriterAdapter): Promise<PageMetadata> {
    const metadata: PageMetadata = {}

    try {
        const session = rewriter.create().on('meta', {
            element(element) {
                const key = element.getAttribute('name') ?? element.getAttribute('property')
                const value = element.getAttribute('content')
                if (key && value !== null) {
                    metadata[key] = value
                }
            },
        })
        await session.transform(response).text()
    } catch (error) {
        ctx.logger.log({
            level: 'error',
            code: 'page-metadata-parse-failed',
            message: 'Failed to parse page metadata; returning empty metadata.',
            error,
        })
    }

    return metadata
}
