import type { PipelineContext } from '../context'

export default function shouldIgnorePath(ctx: PipelineContext, request: Request): boolean {
    const patterns = ctx.config.surfaceDecisionsIgnorePathPatterns
    if (patterns.length === 0) {
        return false
    }
    const { pathname } = new URL(request.url)
    return patterns.some((pattern) => pattern.test(pathname))
}
