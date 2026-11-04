---
"@monetizationos/proxy": patch
---

A `replaceRange` component whose selector matches an element with no end tag (`img`, or a self-closing SVG element such as `<path/>`) no longer fails the whole page transform. That element has no content to cut, so it is left as it is.
