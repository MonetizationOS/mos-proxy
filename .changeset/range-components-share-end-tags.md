---
"@monetizationos/proxy": patch
---

Fix range replacement cut element by element when the containers or markers of several range components share elements. Only the last end tag callback registered on an element runs, so one range's callback dropped another's, and every later container of that range was cut from the wrong markers. Range handlers now share one end tag callback per element.
