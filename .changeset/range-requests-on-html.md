---
"@monetizationos/proxy": patch
---

Range requests for HTML pages now get the whole page. When the origin answers a range request with part of an HTML page, the proxy fetches the page again without `Range` or `If-Range` and runs it through the HTML pipeline as usual. A `multipart/byteranges` response is checked by its first part's type, and ranges of other content are passed through as before. `Range` and `If-Range` are no longer sent to the origin for requests other than GET and HEAD, `Accept-Ranges` and `Content-Range` are removed from HTML responses, and an HTML `Content-Type` is matched whatever its case.

Thanks to [kta1kri](https://github.com/kta1kri) for the report.
