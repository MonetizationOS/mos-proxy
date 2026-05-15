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
    private readonly rewriter: WasmHTMLRewriter
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null
    private readonly preStartChunks: Uint8Array[] = []
    private consumed = false

    constructor() {
        // Output callback fires for each chunk lol-html emits. While the stream's controller
        // hasn't been wired up yet (i.e. before transform()'s start() runs), buffer; afterwards
        // forward each chunk directly to the consumer for genuinely streaming behavior.
        this.rewriter = new WasmHTMLRewriter((chunk) => {
            if (chunk.byteLength === 0) return
            const copy = new Uint8Array(chunk)
            if (this.controller) {
                this.controller.enqueue(copy)
            } else {
                this.preStartChunks.push(copy)
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
                          get text() {
                              return text.text
                          },
                          get lastInTextNode() {
                              return text.lastInTextNode
                          },
                          get removed() {
                              return text.removed
                          },
                          remove: () => {
                              text.remove()
                          },
                          replace: (content, options) => {
                              text.replace(content, toWasmOptions(options))
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
        const preStart = this.preStartChunks
        const setController = (c: ReadableStreamDefaultController<Uint8Array>) => {
            this.controller = c
        }
        const stream = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                setController(controller)
                for (const c of preStart) controller.enqueue(c)
                preStart.length = 0
                try {
                    if (!response.body) {
                        await rewriter.end()
                        controller.close()
                        return
                    }
                    const reader = response.body.getReader()
                    while (true) {
                        const { value, done } = await reader.read()
                        if (done) break
                        if (value && value.byteLength > 0) {
                            await rewriter.write(value)
                        }
                    }
                    await rewriter.end()
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
    get attributes() {
        return element.attributes
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
