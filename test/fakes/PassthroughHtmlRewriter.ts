import type {
    ElementHandlers,
    HtmlRewriterAdapter,
    HtmlRewriterCapabilities,
    HtmlRewriterSession,
} from '../../src/adapters/HtmlRewriterAdapter'

/**
 * Passthrough HTML rewriter that records registered handlers but does not actually parse HTML.
 * Useful for pipeline-orchestration tests where we verify stages wire up correctly without
 * asserting on rewritten markup.
 */
export class PassthroughHtmlRewriter implements HtmlRewriterAdapter {
    readonly capabilities: HtmlRewriterCapabilities = { onEndTag: true, nthChild: true }
    sessions: PassthroughSession[] = []

    create(): HtmlRewriterSession {
        const session = new PassthroughSession()
        this.sessions.push(session)
        return session
    }
}

export class PassthroughSession implements HtmlRewriterSession {
    registered: { selector: string; handlers: ElementHandlers }[] = []

    on(selector: string, handlers: ElementHandlers): this {
        this.registered.push({ selector, handlers })
        return this
    }

    transform(response: Response): Response {
        return response
    }
}
