import type { ElementHandlers, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import type { PipelineContext } from '../context'
import type { WebContentSurfaceBehavior } from '../types'
import { renderElement } from './elements'

const transformPositions = ['before', 'prepend', 'append', 'after'] as const
const reverseTransformPositions: ReadonlyArray<(typeof transformPositions)[number]> = ['after', 'prepend']

export class ContentElementHandler implements ElementHandlers {
    content: WebContentSurfaceBehavior
    private readonly ctx: PipelineContext

    constructor(ctx: PipelineContext, content: WebContentSurfaceBehavior) {
        this.ctx = ctx
        this.content = content
    }

    element(element: RewriterElement) {
        if (element.removed) {
            return
        }

        let retainElement = false
        for (const key of transformPositions) {
            const list = this.content[key]
            if (list?.length) {
                const ordered = reverseTransformPositions.includes(key) ? [...list].reverse() : list
                for (const transformation of ordered) {
                    const [content, options] = renderElement(this.ctx, transformation)
                    element[key](content, options)
                }
                retainElement = true
            }
        }

        if (this.content.remove) {
            if (retainElement) {
                element.replace('', { html: true })
            } else {
                element.remove()
            }
        }
    }
}
