/** Byte stream the test feeds by hand; records whether the reader cancelled it. */
export function controlledStream() {
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c
        },
        cancel() {
            cancelled = true
        },
    })
    return {
        stream,
        push: (...chunks: (string | Uint8Array)[]) => {
            for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
        },
        close: () => controller.close(),
        get cancelled() {
            return cancelled
        },
    }
}
