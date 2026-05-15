import type { CompiledOriginRewriter } from './transformOriginLinks'

/**
 * Streaming byte-scan link rewriter. Holds a rolling tail of `maxMatchLength` bytes so a URL
 * split across a chunk boundary isn't missed.
 */
export function streamingRegexRewriteBody(compiled: CompiledOriginRewriter): TransformStream<Uint8Array, Uint8Array> {
    const { regex, replacement, originHostname, maxMatchLength } = compiled
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let pending = ''

    const rewrite = (s: string) => (s.includes(originHostname) ? s.replace(regex, replacement) : s)

    const flush = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
        if (pending.length === 0) return
        let cut: number
        if (final) {
            cut = pending.length
        } else if (pending.length <= maxMatchLength) {
            return
        } else {
            cut = pending.length - maxMatchLength
            // Extend `cut` forward through any match that crosses the boundary so matches
            // emit atomically — without this, a URL split by the tentative cut would be
            // partially emitted then lost when the prefix slides out of `pending`.
            regex.lastIndex = Math.max(0, cut - maxMatchLength + 1)
            let m: RegExpExecArray | null
            while ((m = regex.exec(pending)) !== null) {
                if (m.index >= cut) break
                const mEnd = m.index + m[0].length
                if (mEnd > cut) cut = mEnd
            }
            regex.lastIndex = 0
        }
        const safe = pending.slice(0, cut)
        pending = pending.slice(cut)
        controller.enqueue(encoder.encode(rewrite(safe)))
    }

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            if (chunk && chunk.byteLength > 0) {
                pending += decoder.decode(chunk, { stream: true })
                flush(controller, false)
            }
        },
        flush(controller) {
            pending += decoder.decode()
            flush(controller, true)
        },
    })
}
