---
"@monetizationos/proxy": patch
---

When MOS rejects a userJwt with 401 (HTTP status or statusCode in the error body):

Log surface-decisions-jwt-rejected
Retry surface-decisions without the JWT:
Use anonymousIdentifier from the anon cookie if present
Otherwise { createAnonymousIdentifier: true }
On success: apply the anonymous workflow/paywall
Clear the invalid JWT cookie (Max-Age=0)
Issue an anonymous session cookie if MOS returns a new identifier
