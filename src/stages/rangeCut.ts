import type { ElementHandlers, HtmlRewriterAdapter, RewriterElement } from '../adapters/HtmlRewriterAdapter'
import type { HtmlStageContext } from '../context'
import type { SurfaceDecisionResponse } from '../types'
import { renderElement } from './elements'
import { createEndTags } from './rangeElements'
import { type Cut, createContainerStack, endCut, firstPhase, startCut } from './rangeTracker'
import { combineSelectors, isCompound, splitSelectorList } from './selectors'
import { isVoidElement } from './voidElements'

type Handler = { selector: string; handler: ElementHandlers }

// Their content is text, so a boundary inserted into it is never parsed as a comment
const RAW_TEXT_ELEMENTS = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'style', 'textarea', 'title', 'xmp'])

/** Why pass 1 can't cut the page, so the caller must redo it element by element */
export type FallbackReason =
    // A handler's selector was rejected
    | 'handler-rejected'
    // Its text holds no boundaries
    | 'inner-raw-text-container'
    // The bytes around them don't balance
    | 'inner-container-deep-in-cut'
    // One's cut would take the other's replacement
    | 'shared-container'
    // The cut would end inside an element it doesn't take whole
    | 'end-marker-not-direct-child'
    // The prefix of its spliced cut can't be parsed on its own
    | 'foreign-start-marker'

export type RangeCut = {
    componentKeys: string[]
    /** Pass 1, ahead of every other component: put boundaries at each container's edges and around its cut. */
    handlers: Handler[]
    /** Why pass 1's output can't be cut, or null when it can */
    fallbackReason: () => FallbackReason | null
    fallBack: (reason: FallbackReason) => void
    /** Drops the boundaries and the cuts between them from pass 1's output, or null when the page must be redone element by element. */
    cut: (page: Uint8Array<ArrayBuffer>, rewriter: HtmlRewriterAdapter, headers: Headers) => Promise<Uint8Array<ArrayBuffer> | null>
}

/** Each boundary's kind, written as one digit */
const Kind = {
    containerStart: 0,
    containerEnd: 1,
    /** The cut starts, after the replacement */
    cutStart: 2,
    /** Before the end marker, where the cut ends */
    cutEnd: 3,
    /** Before a start marker that isn't a direct child, so its cut is spliced: puts back the end tags of what holds the marker */
    restoreEndTags: 4,
    /** Before and after an inner container in the cut, which the cut skips */
    skipStart: 5,
    skipEnd: 6,
} as const
type Kind = (typeof Kind)[keyof typeof Kind]
const KIND_COUNT = Object.keys(Kind).length

type ContainerState = Cut & {
    id: number
    // The container isn't HTML, so a fragment of it can't be parsed on its own
    foreign: boolean
}

/** A handler on `selector` told whether the element also matches `direct`, whose handler runs first and flags it. */
const withDirect = (direct: string, selector: string, visit: (element: RewriterElement, direct: boolean) => void): Handler[] => {
    let flagged = false
    return [
        {
            selector: direct,
            handler: {
                element() {
                    flagged = true
                },
            },
        },
        {
            selector,
            handler: {
                element(element: RewriterElement) {
                    const isDirect = flagged
                    flagged = false
                    visit(element, isDirect)
                },
            },
        },
    ]
}

// Starts every boundary; pages hardly ever hold it
const MARK = 1

/**
 * Cuts each range in one pass and a byte scan, so the cut costs one callback instead of one per element. Pass 1 only
 * writes HTML comment boundaries and the replacement; `cut` then drops the boundaries and the bytes of each cut. The end
 * marker must be a direct child of its container, and an inner container in another one's cut a direct child of it,
 * so the bytes around them balance. A deeper start marker's cut is spliced: it puts back the end tags of the
 * elements the marker sits in. What other components insert inside the cut is removed with it, and a marker removed
 * by another component still marks the cut. A container holding raw text, or inside `math`, is left alone.
 */
export const planRangeCut = (ctx: HtmlStageContext, decisions: SurfaceDecisionResponse): RangeCut | null => {
    const ranges = Object.entries(decisions.componentBehaviors).flatMap(([componentKey, behavior]) => {
        const replaceRange = behavior.content?.replaceRange
        const container = behavior.metadata.cssSelector
        // The component path skips `:last-child` containers
        return replaceRange && container && !container.includes(':last-child') ? [{ componentKey, replaceRange, container }] : []
    })
    if (!ranges.length) {
        return null
    }
    for (const { replaceRange } of ranges) {
        const { fromMarker, toMarker } = replaceRange
        if (fromMarker && toMarker && fromMarker === toMarker) {
            return null
        }
        for (const marker of [fromMarker, toMarker]) {
            if (marker && !splitSelectorList(marker).every(isCompound)) {
                return null
            }
        }
    }

    const nonce = Math.random().toString(36).slice(2, 10)
    const html = { html: true }
    const prefix = `<!--${String.fromCharCode(MARK)}${nonce}-`
    // Every one is written to the page, so `cut` can tell when it has found them all
    let written = 0
    const boundary = (id: number, kind: Kind) => {
        written++
        return `${prefix}${id}-${kind}-->`
    }

    let fallback: FallbackReason | null = null
    const fallBack = (reason: FallbackReason) => {
        fallback ??= reason
    }
    let ids = 0
    // Containers given a cut, which must not lose it while the container stays
    const cutIds = new Set<number>()
    const endTags = createEndTags()
    // Open `math` and `svg` elements. The rewriter mismatches end tags inside MathML, and the cut reads the prefix of
    // a spliced cut as HTML, which misreads SVG's self-closing tags.
    const foreign = { math: 0, svg: 0 }
    // Containers the current element opens, of any range
    let containersHere = 0

    // Ahead of the rest, on every element they are on, so they share its end tag
    const elements = ranges.flatMap(({ container, replaceRange: { fromMarker, toMarker } }) => [
        container,
        ...[fromMarker, toMarker].flatMap((marker) => (marker ? [combineSelectors(container, ' ', marker)] : [])),
    ])
    const handlers: Handler[] = [
        {
            selector: [...elements, 'math', 'svg'].join(', '),
            handler: {
                element() {
                    endTags.start()
                    containersHere = 0
                },
            },
        },
        ...(['math', 'svg'] as const).map((tag) => ({
            selector: tag,
            handler: {
                element(element: RewriterElement) {
                    foreign[tag] += endTags.onEnd(element, () => foreign[tag]--) ? 1 : 0
                },
            },
        })),
    ]
    const markers: Handler[] = []
    const cleanups: Handler[] = []

    for (const { replaceRange, container } of ranges) {
        const { fromMarker, toMarker } = replaceRange
        // Otherwise `${container} > ${container}` also matches an inner one whose parent isn't a container
        const compound = splitSelectorList(container).every(isCompound)
        const replacement = (replaceRange.replaceWith ?? []).map((item) => renderElement(ctx, item))
        // The replacement, then the cut's start. Later `after` and `prepend` content lands closer to the element.
        const insertCut = (insert: RewriterElement['after'], id: number) => {
            insert(boundary(id, Kind.cutStart), html)
            for (const [content, options] of replacement.slice().reverse()) {
                insert(content, options)
            }
            cutIds.add(id)
        }
        // The current element opened a container, so a marker on it is the one it is in's
        let opened = false
        let outer: ContainerState | undefined
        // The current element is an inner container in this cut, which the cut skips
        let skip: ContainerState | null = null
        // Open containers, innermost last. A marker is the innermost one's, and an inner container is cut by its own
        // range while the outer one cuts around it.
        const stack = createContainerStack<ContainerState>(endTags.onEnd)
        const owner = () => (opened ? outer : stack.top())
        // Whether a marker on the element is a direct child of its container
        const onMarker = (marker: string, visit: (element: RewriterElement, direct: boolean) => void) =>
            withDirect(combineSelectors(container, ' > ', marker), combineSelectors(container, ' ', marker), visit)

        handlers.push(
            ...withDirect(combineSelectors(container, ' > ', container), container, (element, direct) => {
                const parent = stack.top()
                if (RAW_TEXT_ELEMENTS.has(element.tagName.toLowerCase()) || foreign.math > 0) {
                    if (parent) {
                        fallBack('inner-raw-text-container')
                    }
                    return
                }
                const id = ids++
                if (!stack.enter(element, { id, phase: firstPhase(fromMarker), foreign: foreign.svg > 0 })) {
                    return
                }
                if (++containersHere > 1) {
                    fallBack('shared-container')
                }
                if (parent?.phase === 'open') {
                    if (!direct || !compound) {
                        fallBack('inner-container-deep-in-cut')
                    }
                    skip = parent
                }
                opened = true
                outer = parent
                // Closed by the container's own end, so what other components append lands outside it
                if (!fromMarker) {
                    insertCut((content, options) => element.prepend(content, options), id)
                }
                element.prepend(boundary(id, Kind.containerStart), html)
                element.append(boundary(id, Kind.containerEnd), html)
            }),
        )
        cleanups.push({
            selector: container,
            handler: {
                element(element: RewriterElement) {
                    // After the marker handlers, as the container may also be the end marker of the cut it is in
                    if (skip?.phase === 'open') {
                        element.before(boundary(skip.id, Kind.skipStart), html)
                        element.after(boundary(skip.id, Kind.skipEnd), html)
                    }
                    skip = null
                    opened = false
                },
            },
        })

        if (toMarker) {
            markers.push(
                ...onMarker(toMarker, (element, direct) => {
                    const range = owner()
                    // Before the start marker, or inside it
                    if (!range || !endCut(range)) {
                        return
                    }
                    if (!direct) {
                        fallBack('end-marker-not-direct-child')
                    }
                    element.before(boundary(range.id, Kind.cutEnd), html)
                }),
            )
        }
        if (fromMarker) {
            markers.push(
                ...onMarker(fromMarker, (element, direct) => {
                    const range = owner()
                    if (!range || !startCut(range, element, endTags.onEnd)) {
                        return
                    }
                    if (!direct) {
                        if (range.foreign || foreign.math > 0) {
                            fallBack('foreign-start-marker')
                        }
                        element.before(boundary(range.id, Kind.restoreEndTags), html)
                    }
                    insertCut((content, options) => element.after(content, options), range.id)
                }),
            )
        }
    }

    return {
        componentKeys: ranges.map(({ componentKey }) => componentKey),
        // Every container handler, then every marker handler, so a marker sees whether it is also a container
        handlers: [...handlers, ...markers, ...cleanups],
        fallbackReason: () => fallback,
        fallBack,
        cut: (page, rewriter, headers) => cut(page, new TextEncoder().encode(prefix), written, cutIds, rewriter, headers),
    }
}

/**
 * Copies the page without its boundaries and cuts, or null where they don't nest: a cut that never ends, or one that
 * takes part of a container open before it. A container still on the page without the start of its cut lost it with
 * what another component removed.
 */
const cut = async (
    page: Uint8Array<ArrayBuffer>,
    prefix: Uint8Array,
    written: number,
    cutIds: Set<number>,
    rewriter: HtmlRewriterAdapter,
    headers: Headers,
): Promise<Uint8Array<ArrayBuffer> | null> => {
    const tokens = boundaries(page, prefix, written)
    if (!tokens) {
        return null
    }
    const out: Uint8Array<ArrayBuffer>[] = []
    let copyFrom = 0
    let cutting: number | null = null
    // Containers that start inside the current cut, so it takes all of them
    const inside = new Set<number>()
    // Containers whose cut skips an inner container, innermost last
    const skipping: number[] = []
    // Where each container's content starts, and where its spliced cut reads the ancestors of its start marker up to
    const contentStart = new Map<number, number>()
    const ancestorsEnd = new Map<number, number>()
    const stayed = new Set<number>()
    const started = new Set<number>()
    for (const { id, kind, start, end } of tokens) {
        if (cutting !== null) {
            if (id === cutting) {
                if ((kind !== Kind.skipStart && kind !== Kind.cutEnd && kind !== Kind.containerEnd) || inside.size) {
                    return null
                }
                if (kind === Kind.skipStart) {
                    skipping.push(id)
                }
                cutting = null
                copyFrom = end
            } else if (kind === Kind.containerStart) {
                inside.add(id)
            } else if (!inside.has(id)) {
                return null
            } else if (kind === Kind.containerEnd) {
                inside.delete(id)
            }
            continue
        }
        out.push(page.subarray(copyFrom, start))
        copyFrom = end
        if (kind === Kind.containerStart) {
            contentStart.set(id, end)
            stayed.add(id)
        } else if (kind === Kind.restoreEndTags) {
            ancestorsEnd.set(id, start)
        } else if (kind === Kind.cutStart) {
            const to = ancestorsEnd.get(id)
            if (to !== undefined) {
                const from = contentStart.get(id)
                const closers = from === undefined ? null : await closingTags(rewriter, page.subarray(from, to), headers)
                if (!closers) {
                    return null
                }
                out.push(closers)
            }
            started.add(id)
            cutting = id
        } else if (kind === Kind.skipEnd) {
            if (skipping.pop() !== id) {
                return null
            }
            cutting = id
        } else if (kind !== Kind.containerEnd || skipping.includes(id)) {
            // An end or skip with no cut open
            return null
        }
    }
    if (cutting !== null || skipping.length) {
        return null
    }
    for (const id of cutIds) {
        if (stayed.has(id) && !started.has(id)) {
            return null
        }
    }
    out.push(page.subarray(copyFrom))
    return concat(out)
}

type Token = { id: number; kind: Kind; start: number; end: number }

/**
 * Every boundary in the page, in order; null when one is malformed. At each cut's start the scan also reads back from
 * the end of the page to the container's next boundary. When the two hold every boundary pass 1 wrote, the bytes
 * between them hold none, so the cut is never read. A boundary can go missing with what another component removes
 * but never appear, so the count can't match by mistake. Each byte is read once, from one end or the other.
 */
const boundaries = (page: Uint8Array, prefix: Uint8Array, written: number) => {
    const markAt = prefix.indexOf(MARK)
    // The boundary whose `MARK` is at `at`, undefined when the bytes there aren't one
    const tokenAt = (at: number): Token | null | undefined => {
        const start = at - markAt
        if (start < 0) {
            return undefined
        }
        for (let i = 0; i < prefix.length; i++) {
            if (page[start + i] !== prefix[i]) {
                return undefined
            }
        }
        let i = start + prefix.length
        const digits = i
        let id = 0
        while ((page[i] ?? 0) >= 48 && (page[i] ?? 0) <= 57) {
            id = id * 10 + (page[i++] as number) - 48
        }
        const kind = ((page[i + 1] ?? 0) - 48) as Kind
        // After the id comes `-`, the kind's digit, then `-->`
        if (
            i === digits ||
            page[i] !== 45 ||
            !(kind >= 0 && kind < KIND_COUNT) ||
            page[i + 2] !== 45 ||
            page[i + 3] !== 45 ||
            page[i + 4] !== 62
        ) {
            return null
        }
        return { id, kind, start, end: i + 5 }
    }
    const forward: Token[] = []
    const backward: Token[] = []
    // Where the scan from the end has read down to
    let to = page.length
    // The native search for the rare `MARK` byte keeps the scan cheap
    for (let at = page.indexOf(MARK); at !== -1 && at < to; at = page.indexOf(MARK, at + 1)) {
        const token = tokenAt(at)
        if (token === null) {
            return null
        }
        if (!token) {
            continue
        }
        forward.push(token)
        if (token.kind !== Kind.cutStart && token.kind !== Kind.skipEnd) {
            continue
        }
        let next: Token | undefined
        while (next?.id !== token.id) {
            const back = to === 0 ? -1 : page.lastIndexOf(MARK, to - 1)
            if (back < token.end) {
                break
            }
            const found = tokenAt(back)
            if (found === null) {
                return null
            }
            to = found?.start ?? back
            if (found) {
                backward.push(found)
                next = found
            }
        }
        if (next?.id === token.id && forward.length + backward.length === written) {
            break
        }
    }
    return forward.concat(backward.reverse())
}

const concat = (chunks: Uint8Array<ArrayBuffer>[]) => {
    const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.length
    }
    return joined
}

/** End tags for the elements still open at the end of `prefix`, innermost first; null if they can't be told. */
const closingTags = async (rewriter: HtmlRewriterAdapter, prefix: Uint8Array<ArrayBuffer>, headers: Headers) => {
    const open: { name: string }[] = []
    let failed = false
    const session = rewriter.create().on('*', {
        element(element: RewriterElement) {
            if (isVoidElement(element)) {
                return
            }
            if (!element.onEndTag) {
                failed = true
                return
            }
            const entry = { name: element.tagName }
            try {
                // An end tag also closes the elements left open inside it
                element.onEndTag(() => {
                    const index = open.lastIndexOf(entry)
                    if (index !== -1) {
                        open.length = index
                    }
                })
                open.push(entry)
            } catch {
                // Self-closing, so never open
            }
        },
    })
    await session.transform(new Response(prefix, { headers })).arrayBuffer()
    const names = open.map(({ name }) => name).reverse()
    // Written as ASCII, whatever the page's encoding
    if (failed || !names.every((name) => /^[\x21-\x7e]+$/.test(name))) {
        return null
    }
    return new TextEncoder().encode(names.map((name) => `</${name}>`).join(''))
}
