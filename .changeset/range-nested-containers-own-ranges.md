---
"@monetizationos/proxy": minor
---

A range's container nested in another of its containers is now cut by its own range. The outer container's cut goes around it and ignores the markers inside it, and keeps what holds it. Previously only the outermost container was cut. A nested container deeper than a direct child of the outer container's cut is cut element by element.

More pages are cut in one pass instead of element by element: a nested start marker on a page with several range components or nested containers, a container left without its end tag when no cut needs its end, a self-closing container, and an element that is both a container and a marker.
