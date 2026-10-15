---
"@monetizationos/proxy": patch
---

Apply `replaceRange` in one rewriter pass and a string cut when its markers are direct children of the container, instead of a callback per element across two passes. Output is unchanged; a 200 KB article's range replacement drops from about 30 ms to 3 ms. Other shapes keep the per-element path.
