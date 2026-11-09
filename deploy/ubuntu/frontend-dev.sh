#!/bin/sh
set -eu
signature=$(sha256sum package-lock.json | cut -d ' ' -f 1)
previous=$(cat node_modules/.mw-lock 2>/dev/null || true)
if [ "$signature" != "$previous" ]; then
  npm ci --no-audit --no-fund
  printf '%s' "$signature" > node_modules/.mw-lock
fi
exec node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173 --strictPort
