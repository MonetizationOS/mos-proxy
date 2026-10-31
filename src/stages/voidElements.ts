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

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

/**
 * HTML void elements have no end tag, and rewriter runtimes throw when `onEndTag` is called on them. Only elements in
 * the HTML namespace are void: a `<link>` inside `<svg>` has an end tag, so an element that doesn't report its namespace is
 * never treated as void. Self-closing foreign elements (`<path/>` in
 * SVG) throw too but cannot be recognised by name, so callers keep a try/catch.
 */
export const isVoidElement = (element: RewriterElement): boolean =>
    VOID_ELEMENTS.has(element.tagName) && element.namespaceURI === HTML_NAMESPACE
