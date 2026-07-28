# PROTOTYPE: workerd resolution probe (throwaway)

Not production code. Delete it or move it to a throwaway branch once the answer is captured.

## Question

Does the ESM specifier change in MD-2245 resolve and execute in the real Workers runtime?

`pnpm verify:package` proves the package imports from plain Node, and an esbuild bundle proves it
links. Neither runs workerd. This probe closes that gap by serving the packed tarball through
`wrangler dev`, which bundles exactly as a consumer would and then executes in workerd.

## Run

```sh
./run.sh
```

It packs the current working tree, installs the tarball with npm, boots `wrangler dev`, hits
`/__probe`, prints the result, and tears the server down.

## Reading the output

`runtime` must report `Cloudflare-Workers`. If it says anything else, the probe fell back to Node
and proves nothing. `proxyHandleStatus` exercises the real request path, so a 200 means the module
graph loaded and ran, not merely that the import resolved.
