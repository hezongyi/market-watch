#!/usr/bin/env bash
set -euo pipefail
release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec docker compose --env-file "$release_dir/v1.3.2-ui.env" \
  --project-name market-watch-v132-ui -f "$release_dir/v1.3.2-ui.yaml" "$@"
