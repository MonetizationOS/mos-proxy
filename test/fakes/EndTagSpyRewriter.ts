import type {
    ElementHandlers,
    HtmlRewriterAdapter,
    HtmlRewriterCapabilities,
    HtmlRewriterSession,
    RewriterElement,
} from '../../src/adapters/HtmlRewriterAdapter'
import { LolHtmlRewriter } from './LolHtmlRewriter'

/** Wraps the real rewriter and records the tag of every element `onEndTag` is called on. */
export class EndTagSpyRewriter implements HtmlRewriterAdapter {
    readonly inner = new LolHtmlRewriter()
    readonly capabilities: HtmlRewriterCapabilities = this.inner.capabilities
    readonly endTagCalls: string[] = []

    // Methods are bound to the element, which a real rewriter element needs
    private spyOn(element: RewriterElement): RewriterElement {
        const onEndTag: RewriterElement['onEndTag'] = (callback) => {
            this.endTagCalls.push(element.tagName.toLowerCase())
            element.onEndTag?.(callback)
        }
        return new Proxy(element, {
            get: (target, prop) => {
                if (prop === 'onEndTag') {
                    return onEndTag
                }
                const value = Reflect.get(target, prop)
                return typeof value === 'function' ? value.bind(target) : value
            },
        })
    }

    create(): HtmlRewriterSession {
        const session = this.inner.create()
        const spy: HtmlRewriterSession = {
            on: (selector: string, handlers: ElementHandlers) => {
                session.on(selector, {
                    ...handlers,
                    element: handlers.element ? (element) => handlers.element?.(this.spyOn(element)) : undefined,
                })
                return spy
            },
            transform: (response) => session.transform(response),
        }
        return spy
    }
}
