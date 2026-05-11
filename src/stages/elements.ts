import type { ContentOptions } from '../adapters/HtmlRewriterAdapter'
import type { PipelineContext } from '../context'
import type { WebComponentElement, WebElement } from '../types'

export const renderElement = (ctx: PipelineContext, element: WebElement): [string, ContentOptions] => {
    try {
        const mapped = {
            ...element,
            type: element.type?.toLowerCase(),
        } as WebElement

        if (mapped.type === 'html') {
            return [mapped.content, { html: true }]
        }

        if (mapped.type === 'text') {
            return [mapped.content, { html: false }]
        }

        if (mapped.type === 'element') {
            return [renderComponentElement(mapped), { html: true }]
        }
    } catch (error) {
        ctx.logger.log({
            level: 'error',
            code: 'element-render-failed',
            message: 'Failed to render element; substituting empty content.',
            context: { type: element.type },
            error,
        })
        return ['', { html: false }]
    }

    ctx.logger.log({
        level: 'warn',
        code: 'element-type-unsupported',
        message: 'Unsupported element type; substituting empty content.',
        context: { type: element.type },
    })
    return ['', { html: false }]
}

export const renderComponentElement = (component: WebComponentElement): string => {
    const [schemaSource, versionedSchemaId] = component.schema.split(':')
    const [schemaId, schemaVersion] = versionedSchemaId?.split('@') ?? []
    const webComponentTag = `${schemaSource}-${schemaId}`
    const escapedPropsAttribute = JSON.stringify(component.props).replace(/"/g, '&quot;')

    return `<${webComponentTag} version="${schemaVersion ?? ''}" props="${escapedPropsAttribute}"></${webComponentTag}>`
}
