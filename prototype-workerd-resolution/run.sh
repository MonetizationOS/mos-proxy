#!/usr/bin/env bash
# PROTOTYPE: throwaway. See README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8787}"
cd "$HERE"

# package.json pins the tarball at a fixed name, so pack to that name rather than the versioned one.
echo "=== packing the working tree"
rm -f ./*.tgz
(cd "$REPO" && pnpm pack --pack-destination "$HERE" >/dev/null)
mv ./monetizationos-proxy-*.tgz ./mos-proxy.tgz
echo "packed mos-proxy.tgz"

# npm resolves a file: dependency by path, so a stale node_modules would silently probe an old
# tarball, which is the one thing this prototype must never do.
echo "=== installing (npm, to match a published consumer)"
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund --loglevel=error

echo "=== booting wrangler dev on :$PORT"
npx wrangler dev --port "$PORT" --local > wrangler.log 2>&1 &
WRANGLER_PID=$!
trap 'kill $WRANGLER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/__probe" >/dev/null 2>&1; then break; fi
    sleep 1
done

echo "=== /__probe"
if ! curl -sf "http://127.0.0.1:$PORT/__probe"; then
    echo "probe failed, wrangler log follows:"
    cat wrangler.log
    exit 1
fi
echo
