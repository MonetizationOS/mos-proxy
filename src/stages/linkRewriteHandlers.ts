import type { ElementHandlers, HtmlRewriterSession, RewriterElement, RewriterText } from '../adapters/HtmlRewriterAdapter'
import { compileOriginLinkRewriter } from './transformOriginLinks'

export function registerLinkRewriteHandlers(session: HtmlRewriterSession, requestUrl: URL, originUrl: URL): HtmlRewriterSession {
    const rewrite = compileOriginLinkRewriter(requestUrl, originUrl)
    session.on('*', {
        element(element: RewriterElement) {
            const attributes = Array.from(element.attributes)
            for (const [name, value] of attributes) {
                if (value === null) continue

                const next = rewrite(value)
                if (next !== value) {
                    element.setAttribute(name, next)
                }
            }
        },
    })
    session.on('script, style, template', new BufferedTextRewriter(rewrite))
    return session
}

// Sharing one buffer across calls is safe because lol-html serializes all text callbacks for one
// matched element (ending with lastInTextNode=true) before the next element's element callback.
class BufferedTextRewriter implements ElementHandlers {
    private chunks: string[] = []

    constructor(private readonly rewrite: (s: string) => string) {}

    element = (_element: RewriterElement) => {
        this.chunks = []
    }

    text = (chunk: RewriterText) => {
        if (chunk.lastInTextNode) {
            this.chunks.push(chunk.text)
            const joined = this.chunks.length === 1 ? (this.chunks[0] ?? '') : this.chunks.join('')
            this.chunks = []
            chunk.replace(this.rewrite(joined), { html: false })
        } else {
            this.chunks.push(chunk.text)
            chunk.remove()
        }
    }
}
