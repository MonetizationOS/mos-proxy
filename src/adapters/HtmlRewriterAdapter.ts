/**
 * Platform-agnostic contract over lol-html-style streaming HTML rewriters
 * (Cloudflare's `HTMLRewriter`, Fastly's `HTMLRewritingStream`, Akamai's `HtmlRewritingStream`).
 *
 * An adapter creates a new rewriter session per call to `create()`; the session is a builder
 * that accepts selectors + handlers via `.on(...)` and produces a transformed `Response` via
 * `.transform(response)`.
 *
 * `capabilities` advertises which lol-html features the underlying implementation supports.
 * Consumers dispatch on these flags to enable or fall back paths (e.g., range-replacement
 * via `element.onEndTag` vs. a sentinel post-process).
 */
export interface HtmlRewriterAdapter {
    readonly capabilities: HtmlRewriterCapabilities
    create(): HtmlRewriterSession
}

export interface HtmlRewriterCapabilities {
    /** Element handlers can register an end-tag callback via `element.onEndTag(cb)`. */
    onEndTag: boolean
    /** `:nth-child()` CSS pseudo-class is supported in selectors. */
    nthChild: boolean
}

export interface HtmlRewriterSession {
    on(selector: string, handlers: ElementHandlers): HtmlRewriterSession
    transform(response: Response): Response
}

export interface ElementHandlers {
    element?(element: RewriterElement): void | Promise<void>
    text?(text: RewriterText): void | Promise<void>
}

export interface ContentOptions {
    html?: boolean
}

/**
 * Mirrors the Cloudflare `Element` API (a lol-html `HTMLRewriterElement`).
 *
 * Adapters may throw from `onEndTag` on runtimes that don't support it; callers should
 * check `capabilities.onEndTag` before relying on it, or catch the error.
 */
export interface RewriterElement {
    readonly removed: boolean
    readonly tagName: string
    readonly attributes: Iterable<[string, string]>
    getAttribute(name: string): string | null
    hasAttribute(name: string): boolean
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
    before(content: string, options?: ContentOptions): void
    after(content: string, options?: ContentOptions): void
    prepend(content: string, options?: ContentOptions): void
    append(content: string, options?: ContentOptions): void
    replace(content: string, options?: ContentOptions): void
    remove(): void
    onEndTag?(callback: () => void | Promise<void>): void
}

export interface RewriterText {
    readonly text: string
    readonly lastInTextNode: boolean
    readonly removed: boolean
    remove(): void
    replace(content: string, options?: ContentOptions): void
}
