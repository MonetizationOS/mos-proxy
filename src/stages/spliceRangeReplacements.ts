import type { HtmlRewriterAdapter } from '../adapters/HtmlRewriterAdapter'
import type { SubSurfaceBehaviorApi, SurfaceDecisionResponse, WebComponentRangeReplacement } from '../types'

type RangeBehavior = SubSurfaceBehaviorApi & { metadata: { cssSelector: string }; content: { replaceRange: WebComponentRangeReplacement } }

/**
 * `buildReplacementHandlers` cuts a range element by element, after a marker pass over a clone: a callback per
 * element in the container, twice. On a long article that is tens of milliseconds. When every range has the simple
 * shape (markers that are direct children of one container) this marks each cut with comments in one pass and slices
 * the string instead, leaving a placeholder component whose `before` renders `replaceWith`, so rendering stays in
 * `ContentElementHandler`.
 *
 * Returns null when there is no range, or when any range has another shape; the caller then runs the per-element path
 * on the whole decision, so the output is the same either way.
 */
export async function spliceRangeReplacements(
    response: Response,
    surfaceDecisions: SurfaceDecisionResponse,
    rewriter: HtmlRewriterAdapter,
): Promise<{ response: Response; surfaceDecisions: SurfaceDecisionResponse } | null> {
    const ranges = Object.entries(surfaceDecisions.componentBehaviors).filter(
        (entry): entry is [string, RangeBehavior] => !!entry[1].metadata?.cssSelector && !!entry[1].content?.replaceRange,
    )
    if (!ranges.length || !response.body) {
        return null
    }

    const nonce = crypto.randomUUID()
    const mark = (kind: 'start' | 'to' | 'end', k: number, m: number) => `<!--mos-range-${nonce}-${kind}-${k}-${m}-->`
    const cuts: { k: number; m: number; ended: boolean }[] = []
    let eligible = true
    let marked: string

    try {
        let session = rewriter.create()
        ranges.forEach(([, behavior], k) => {
            const selector = behavior.metadata.cssSelector
            const { fromMarker, toMarker } = behavior.content.replaceRange
            // buildReplacementHandlers skips a range whose markers are identical, with a warning; leave that to it.
            if (fromMarker && fromMarker === toMarker) {
                eligible = false
                return
            }
            let open: { m: number; started: boolean; ended: boolean; inStart: boolean; fromSeen: number; toSeen: number } | null = null
            let m = -1

            // Handlers for one element run in registration order, so the any-depth handler always counts first.
            session = session.on(selector, {
                element(element) {
                    if (open || !element.onEndTag) {
                        eligible = false // nested containers
                        return
                    }
                    const cut = { k, m: ++m, ended: false }
                    const range = { m: cut.m, started: !fromMarker, ended: false, inStart: false, fromSeen: 0, toSeen: 0 }
                    open = range
                    cuts.push(cut)
                    if (!fromMarker) {
                        element.prepend(mark('start', k, cut.m), { html: true })
                    }
                    // Appended content lands just before the end tag.
                    element.append(mark('end', k, cut.m), { html: true })
                    element.onEndTag(() => {
                        // A marker matched only below a direct child: the per-element path keeps that child's ancestors.
                        if ((range.fromSeen && !range.started) || (range.toSeen && !range.ended)) {
                            eligible = false
                        }
                        cut.ended = range.ended
                        open = null
                    })
                },
            })
            if (fromMarker) {
                session = session
                    .on(`${selector} ${fromMarker}`, {
                        element() {
                            if (open && !open.started) open.fromSeen++
                        },
                    })
                    .on(`${selector} > ${fromMarker}`, {
                        element(element) {
                            const range = open
                            if (!range || range.started) return
                            if (range.fromSeen !== 1 || !element.onEndTag) {
                                eligible = false
                                return
                            }
                            range.started = true
                            range.inStart = true
                            element.after(mark('start', k, range.m), { html: true })
                            // Until the start marker closes the per-element path is still scanning, so a toMarker inside it doesn't count.
                            element.onEndTag(() => {
                                range.inStart = false
                            })
                        },
                    })
            }
            if (toMarker) {
                session = session
                    .on(`${selector} ${toMarker}`, {
                        element() {
                            if (open?.started && !open.inStart && !open.ended) open.toSeen++
                        },
                    })
                    .on(`${selector} > ${toMarker}`, {
                        element(element) {
                            const range = open
                            if (!range?.started || range.inStart || range.ended) return
                            if (range.toSeen !== 1) {
                                eligible = false
                                return
                            }
                            range.ended = true
                            element.before(mark('to', k, range.m), { html: true })
                        },
                    })
            }
        })
        if (!eligible) {
            return null
        }
        marked = await session.transform(new Response(await response.clone().text(), { headers: { 'content-type': 'text/html' } })).text()
    } catch {
        // An invalid selector: the per-element path logs it and skips that range.
        return null
    }
    if (!eligible) {
        return null
    }

    // Cut from each start marker to its toMarker or the container's end, last first so offsets stay valid.
    const spans = cuts
        .map(({ k, m, ended }) => {
            const start = mark('start', k, m)
            const stop = mark(ended ? 'to' : 'end', k, m)
            const from = marked.indexOf(start)
            const to = from < 0 ? -1 : marked.indexOf(stop, from)
            const hasReplacement = !!ranges[k]?.[1].content.replaceRange.replaceWith?.length
            return { k, from, to: to < 0 ? -1 : to + stop.length, hasReplacement }
        })
        .filter((span) => span.from >= 0)
        .sort((a, b) => a.from - b.from)
    if (spans.some((span, i) => span.to < 0 || span.from < (spans[i - 1]?.to ?? 0))) {
        return null // overlapping ranges
    }

    let html = marked
    for (const span of [...spans].reverse()) {
        html = html.slice(0, span.from) + (span.hasReplacement ? placeholder(nonce, span.k) : '') + html.slice(span.to)
    }
    html = html.replaceAll(new RegExp(`<!--mos-range-${nonce}-[a-z]+-\\d+-\\d+-->`, 'g'), '')

    const componentBehaviors = { ...surfaceDecisions.componentBehaviors }
    ranges.forEach(([key, behavior], k) => {
        const { replaceRange, ...content } = behavior.content
        componentBehaviors[key] = { ...behavior, content }
        if (replaceRange.replaceWith?.length) {
            componentBehaviors[`mos-range-${nonce}-${k}`] = {
                metadata: { cssSelector: `mos-range-cut[data-mos-range="${nonce}-${k}"]` },
                content: { before: replaceRange.replaceWith, remove: true },
            }
        }
    })

    // The body changed length; the runtime sets Content-Length for the new one.
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return {
        response: new Response(html, { status: response.status, statusText: response.statusText, headers }),
        surfaceDecisions: { ...surfaceDecisions, componentBehaviors },
    }
}

const placeholder = (nonce: string, k: number) => `<mos-range-cut data-mos-range="${nonce}-${k}"></mos-range-cut>`
