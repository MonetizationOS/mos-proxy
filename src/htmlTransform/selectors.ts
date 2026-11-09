const withoutNested = (selector: string) => selector.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]|\([^)]*\)/g, '')
// One compound selector, so `${container} > ${marker}` only matches a direct child
export const isCompound = (selector: string) => !/[\s>+~]/.test(withoutNested(selector.trim()))

/** The top-level parts of a selector list. */
export const splitSelectorList = (selector: string): string[] => {
    const parts: string[] = []
    let nesting = 0
    let quote = ''
    let start = 0
    for (let i = 0; i < selector.length; i++) {
        const char = selector[i]
        if (char === '\\') {
            i++
        } else if (quote) {
            quote = char === quote ? '' : quote
        } else if (char === '"' || char === "'") {
            quote = char
        } else if (char === '(' || char === '[') {
            nesting++
        } else if (char === ')' || char === ']') {
            nesting--
        } else if (char === ',' && nesting === 0) {
            parts.push(selector.slice(start, i).trim())
            start = i + 1
        }
    }
    parts.push(selector.slice(start).trim())
    return parts
}

/** `${container}${combinator}${inner}` for every pair of parts, so a list on either side keeps the combinator. */
export const combineSelectors = (container: string, combinator: ' ' | ' > ', inner: string) => {
    const outers = splitSelectorList(container)
    const inners = splitSelectorList(inner)
    // An empty part (`.a,,.b`, `.a,`) is invalid; kept as is so the rewriter still rejects it
    if (outers.includes('') || inners.includes('')) {
        return `${container}${combinator}${inner}`
    }
    return outers.flatMap((outer) => inners.map((part) => `${outer}${combinator}${part}`)).join(', ')
}
