import type { RewriterElement } from '../adapters/HtmlRewriterAdapter'

const VOID_ELEMENTS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
])

/**
 * HTML void elements have no end tag, and rewriter runtimes throw when `onEndTag` is called on them. Self-closing
 * foreign elements (`<path/>` in SVG) throw too but cannot be recognised by name, so callers keep a try/catch.
 */
export const isVoidElement = (element: RewriterElement): boolean => VOID_ELEMENTS.has(element.tagName)
