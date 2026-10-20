---
"@monetizationos/proxy": minor
---

Origin requests carry the viewer's host and protocol as `X-Forwarded-Host` and `X-Forwarded-Proto`, so origins can build URLs on the public domain. `originRequestHeaders` can override either.
