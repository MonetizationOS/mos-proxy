---
"@monetizationos/proxy": minor
---

The surface decision request goes out once the page head has been read, instead of after the whole origin page. Page metadata is read up to `<body>`, or about the first 1 MB when the page has none, so `<meta>` tags in the body are no longer sent as resource metadata. This also applies to the exported `parsePageMetadata`. Link rewriting now streams the body instead of buffering it; output is unchanged. Cancelling the response, or a workflow body replacing the page, now cancels the origin.
