import { type Element as WasmElement, HTMLRewriter as WasmHTMLRewriter } from 'html-rewriter-wasm'
import type {
    ContentOptions,
    ElementHandlers,
    HtmlRewriterAdapter,
    HtmlRewriterCapabilities,
    HtmlRewriterSession,
    RewriterElement,
} from '../../src/adapters/HtmlRewriterAdapter'

/**
 * Real (WASM lol-html) HTML rewriter used in tests so we exercise actual parsing,
 * selector matching, and mutation semantics instead of recording handlers in a fake.
 */
export class LolHtmlRewriter implements HtmlRewriterAdapter {
    readonly capabilities: HtmlRewriterCapabilities = { onEndTag: true, nthChild: true }

    create(): HtmlRewriterSession {
        return new LolHtmlSession()
    }
}

class LolHtmlSession implements HtmlRewriterSession {
    private readonly chunks: Uint8Array[] = []
    private readonly rewriter: WasmHTMLRewriter
    private consumed = false

    constructor() {
        this.rewriter = new WasmHTMLRewriter((chunk) => {
            if (chunk.byteLength > 0) {
                this.chunks.push(new Uint8Array(chunk))
            }
        })
    }

    on(selector: string, handlers: ElementHandlers): this {
        // Register synchronously so selector parser errors surface to the caller (matches
        // real lol-html / Cloudflare HTMLRewriter behavior). Handlers may be class instances
        // (e.g. ContentElementHandler) that rely on `this`, so always invoke via the object.
        this.rewriter.on(selector, {
            element: handlers.element
                ? async (element) => {
                      await handlers.element?.(adaptElement(element))
                  }
                : undefined,
            text: handlers.text
                ? async (text) => {
                      await handlers.text?.({
                          text: text.text,
                          lastInTextNode: text.lastInTextNode,
                          removed: text.removed,
                          remove: () => {
                              text.remove()
                          },
                      })
                  }
                : undefined,
        })
        return this
    }

    transform(response: Response): Response {
        if (this.consumed) {
            throw new Error('LolHtmlRewriter session can only transform a single response')
        }
        this.consumed = true

        const rewriter = this.rewriter
        const chunks = this.chunks
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    const body = await response.text()
                    await rewriter.write(new TextEncoder().encode(body))
                    await rewriter.end()
                    for (const chunk of chunks) {
                        controller.enqueue(chunk)
                    }
                    controller.close()
                } catch (error) {
                    controller.error(error)
                } finally {
                    rewriter.free()
                }
            },
        })

        return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    }
}

const adaptElement = (element: WasmElement): RewriterElement => ({
    get removed() {
        return element.removed
    },
    get tagName() {
        return element.tagName
    },
    getAttribute: (name) => element.getAttribute(name),
    hasAttribute: (name) => element.hasAttribute(name),
    setAttribute: (name, value) => {
        element.setAttribute(name, value)
    },
    removeAttribute: (name) => {
        element.removeAttribute(name)
    },
    before: (content, options) => {
        element.before(content, toWasmOptions(options))
    },
    after: (content, options) => {
        element.after(content, toWasmOptions(options))
    },
    prepend: (content, options) => {
        element.prepend(content, toWasmOptions(options))
    },
    append: (content, options) => {
        element.append(content, toWasmOptions(options))
    },
    replace: (content, options) => {
        element.replace(content, toWasmOptions(options))
    },
    remove: () => {
        element.remove()
    },
    onEndTag: (callback) => {
        element.onEndTag(async () => {
            await callback()
        })
    },
})

const toWasmOptions = (options?: ContentOptions): { html?: boolean } | undefined =>
    options?.html === undefined ? undefined : { html: options.html }
