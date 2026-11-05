---
"@monetizationos/proxy": patch
---

A range starts at the first start marker in its container, so a start marker nested inside it no longer inserts the replacement a second time. A range also applies to the outermost matching container: a container nested inside another one is part of the outer container's range instead of getting a cut of its own.
