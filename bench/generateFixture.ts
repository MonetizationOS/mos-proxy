// Deterministic ~2MB HTML fixture exercising every URL_ATTRS case plus large
// <script>/<style>/<template> blobs. Deterministic so runs are comparable.

const ORIGIN = 'https://origin.example.com'

// xorshift32: small deterministic PRNG so we don't pull in a dep.
const prng = (seed: number) => {
    let s = seed | 0 || 1
    return () => {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        return (s >>> 0) / 0xffffffff
    }
}

export function buildFixture(targetBytes = 2_000_000, seed = 0xdecafbad): string {
    const rand = prng(seed)
    const parts: string[] = []
    parts.push('<!doctype html><html manifest="', ORIGIN, '/app.manifest"><head>')

    // Every meta variant the rewriter cares about.
    parts.push('<base href="', ORIGIN, '/">')
    parts.push('<meta property="og:url" content="', ORIGIN, '/article">')
    parts.push('<meta property="og:image" content="', ORIGIN, '/og.png">')
    parts.push('<meta http-equiv="refresh" content="5; url=', ORIGIN, '/refresh">')
    parts.push('<link rel="canonical" href="', ORIGIN, '/canonical">')
    parts.push('<link rel="preload" as="image" imagesrcset="', ORIGIN, '/preload-a.png 1x, ', ORIGIN, '/preload-b.png 2x">')

    // Big <style> blob (~200KB) with many url(...) refs.
    parts.push('<style>')
    parts.push(buildBigCss(200_000, rand))
    parts.push('</style>')

    parts.push('</head><body background="', ORIGIN, '/body-bg.png">')

    // SVG with href + xlink:href.
    parts.push(
        '<svg><image href="',
        ORIGIN,
        '/a.png"/><use xlink:href="',
        ORIGIN,
        '/icons.svg#x"/><a href="',
        ORIGIN,
        '/svg-link"><circle/></a></svg>',
    )

    // iframe srcdoc with embedded HTML (entity-escaped).
    parts.push('<iframe srcdoc="&lt;a href=&quot;', ORIGIN, '/in-srcdoc&quot;&gt;x&lt;/a&gt;"></iframe>')

    // <object> with codebase/archive.
    parts.push('<object data="', ORIGIN, '/plugin.swf" codebase="', ORIGIN, '/cb" archive="', ORIGIN, '/a.jar"></object>')

    // Microdata / RDFa.
    parts.push('<div itemid="', ORIGIN, '/thing" resource="', ORIGIN, '/res" about="', ORIGIN, '/about"></div>')

    // Form/input.
    parts.push('<form action="', ORIGIN, '/submit">')
    parts.push('<button formaction="', ORIGIN, '/btn">Go</button>')
    parts.push('<input formaction="', ORIGIN, '/in"/>')
    parts.push('<input type="image" src="', ORIGIN, '/img-input.png"/>')
    parts.push('</form>')

    // Quote elements with cite.
    parts.push('<blockquote cite="', ORIGIN, '/q"></blockquote>')
    parts.push('<q cite="', ORIGIN, '/q2"></q>')
    parts.push('<del cite="', ORIGIN, '/d"></del>')
    parts.push('<ins cite="', ORIGIN, '/i"></ins>')

    // Media.
    parts.push('<video poster="', ORIGIN, '/poster.png" src="', ORIGIN, '/v.mp4">')
    parts.push('<track src="', ORIGIN, '/captions.vtt"/>')
    parts.push('<source src="', ORIGIN, '/v.webm" srcset="', ORIGIN, '/a.webm 1x, ', ORIGIN, '/b.webm 2x"/>')
    parts.push('</video>')
    parts.push('<audio src="', ORIGIN, '/a.mp3"></audio>')
    parts.push('<embed src="', ORIGIN, '/embed.swf"/>')

    // <template>.
    parts.push('<template><a href="', ORIGIN, '/tmpl">x</a><script>var t="', ORIGIN, '/tmpl-js"</script></template>')

    // A long body of <article> blocks (many elements, many attributes) to amplify
    // selector-matching cost. Aim for ~800KB of articles.
    parts.push(buildArticles(800_000, rand))

    // Two big <script> blobs with embedded origin URLs.
    parts.push('<script>')
    parts.push(buildBigScript(400_000, rand))
    parts.push('</script>')
    parts.push('<script>')
    parts.push(buildBigScript(400_000, rand))
    parts.push('</script>')

    // Some prose mentioning the origin URL (should NOT be rewritten — locks in option-3 behavior).
    parts.push('<p>For reference, the canonical origin is ', ORIGIN, '/foo (this is prose).</p>')

    parts.push('</body></html>')

    let out = parts.join('')
    // Pad to target size with extra <article> blocks if we're short.
    if (out.length < targetBytes) {
        out = out.replace('</body></html>', `${buildArticles(targetBytes - out.length, rand)}</body></html>`)
    }
    return out
}

function buildBigCss(targetBytes: number, rand: () => number): string {
    const chunks: string[] = []
    let size = 0
    let n = 0
    while (size < targetBytes) {
        const useOrigin = rand() < 0.3
        const url = useOrigin ? `${ORIGIN}/img/${n}.png` : `https://cdn.example.org/img/${n}.png`
        const rule = `.cls-${n} { background: url(${url}); color: #${((rand() * 0xffffff) | 0).toString(16).padStart(6, '0')}; padding: ${(rand() * 32) | 0}px; }\n`
        chunks.push(rule)
        size += rule.length
        n++
    }
    return chunks.join('')
}

function buildBigScript(targetBytes: number, rand: () => number): string {
    const chunks: string[] = []
    let size = 0
    let n = 0
    while (size < targetBytes) {
        const useOrigin = rand() < 0.2
        const url = useOrigin ? `${ORIGIN}/api/v${n}` : `https://cdn.example.org/api/v${n}`
        // Mix of fetch-like patterns, object literals, comments, regex-looking content, etc.
        const stmt = `const u${n} = "${url}"; fetch(u${n}, { method: "GET" }).then(r => r.json()); // line ${n}\nconst x${n} = ${(rand() * 1e9) | 0}; const arr${n} = [${(rand() * 10) | 0}, ${(rand() * 10) | 0}, ${(rand() * 10) | 0}];\n`
        chunks.push(stmt)
        size += stmt.length
        n++
    }
    return chunks.join('')
}

function buildArticles(targetBytes: number, rand: () => number): string {
    const chunks: string[] = []
    let size = 0
    let n = 0
    while (size < targetBytes) {
        const useOrigin1 = rand() < 0.5
        const useOrigin2 = rand() < 0.5
        const useOrigin3 = rand() < 0.5
        const href = useOrigin1 ? `${ORIGIN}/post/${n}` : `https://other.example.org/post/${n}`
        const imgSrc = useOrigin2 ? `${ORIGIN}/img/${n}.jpg` : `https://cdn.example.org/img/${n}.jpg`
        const srcset = useOrigin3
            ? `${ORIGIN}/img/${n}-1x.jpg 1x, ${ORIGIN}/img/${n}-2x.jpg 2x`
            : `https://cdn.example.org/img/${n}-1x.jpg 1x, https://cdn.example.org/img/${n}-2x.jpg 2x`
        const block =
            `<article id="a-${n}" data-id="${n}" data-src="${ORIGIN}/lazy/${n}.jpg" data-href="${ORIGIN}/click/${n}" style="background: url(${ORIGIN}/bg/${n}.png)">` +
            `<a href="${href}" ping="${ORIGIN}/ping/${n}"><img src="${imgSrc}" srcset="${srcset}" usemap="${ORIGIN}/map#${n}" longdesc="${ORIGIN}/ld/${n}"></a>` +
            `<p>Body text for article ${n} talking about things. No URL replacement should happen in this prose.</p>` +
            `<blockquote cite="${ORIGIN}/q/${n}">quoted ${n}</blockquote>` +
            `</article>\n`
        chunks.push(block)
        size += block.length
        n++
    }
    return chunks.join('')
}

// Allow running directly: `node --experimental-strip-types bench/generateFixture.ts > /tmp/fixture.html`
if (import.meta.url === `file://${process.argv[1]}`) {
    process.stdout.write(buildFixture())
}
