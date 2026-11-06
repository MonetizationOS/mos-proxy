---
"@monetizationos/proxy": patch
---

Range replacement fixes:

- Uses less CPU on pages with many void elements (`img`, `br`, `meta`, ...). Output is unchanged.
- A range container with no end tag (`img`, or a self-closing SVG element such as `<path/>`) is left as it is instead of failing the whole page transform.
- A range starts at the first start marker, so a start marker nested inside it no longer inserts the replacement a second time.
- A range applies to the outermost matching container. A container nested inside another one is part of the outer container's cut.
