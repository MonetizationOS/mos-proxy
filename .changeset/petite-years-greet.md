---
"@monetizationos/proxy": minor
---

Introduce streaming link rewriting for text-based payloads using a chunk-safe rolling-window regex. HTML payloads retain regex rewriting by default.

Add `withHtmlAwareLinkRewriting()` builder method and `htmlAwareLinkRewritingEnabled` option for routing HTML through the streaming lol-html rewriter. This combines link rewriting and page-metadata extraction in a single parse pass, optimizing `surfaceDecisions`.

Strip `Content-Length` and `Content-Encoding` headers when re-streaming bodies.
