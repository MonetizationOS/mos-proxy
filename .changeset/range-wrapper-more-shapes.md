---
"@monetizationos/proxy": minor
---

More pages use the one-callback range cut. Content other components insert inside the range is removed with it, whatever the component order, and a marker removed by another component still marks where the range starts or ends. A container holding raw text, such as `textarea` or `script`, is left alone, and only the outermost of nested containers is cut. Selector lists, several range components in one decision, and other content on the range component all use the one-callback path. Selector lists also apply per part when cutting element by element.
