---
"@monetizationos/proxy": minor
---

A range's container nested in another of its containers is now cut by its own range. The outer container's cut goes around it and ignores the markers inside it, and keeps what holds it. Previously only the outermost container was cut. A nested container deeper than a direct child of the outer container's cut, or on a page whose start marker needs a nested cut, is cut element by element.
