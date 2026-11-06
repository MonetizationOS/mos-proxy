---
"@monetizationos/proxy": minor
---

Range replacement cuts the range with one callback instead of one per element when the start and end markers are direct children of the container. Other pages are cut element by element as before. `RewriterElement` now requires `removeAndKeepContent`, which lol-html and `HTMLRewriter` elements already implement. A page with a range is now buffered before it is rewritten, and HTML comments inside the cut range are removed with it.
