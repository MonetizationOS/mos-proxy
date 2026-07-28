#!/usr/bin/env bash
# PROTOTYPE: throwaway. See README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8787}"
cd "$HERE"

echo "=== packing the working tree"
rm -f ./*.tgz
(cd "$REPO" && pnpm pack --pack-destination "$HERE" >/dev/null)
TARBALL="$(ls ./*.tgz)"
echo "packed $TARBALL"

echo "=== installing wrangler and the tarball (npm, to match a published consumer)"
cat > package.json <<'JSON'
{
  "name": "prototype-workerd-resolution",
  "private": true,
  "type": "module"
}
JSON
npm install wrangler "$TARBALL" --no-audit --no-fund --loglevel=error

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
