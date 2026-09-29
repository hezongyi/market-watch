#!/usr/bin/env bash
# Run from the host user's terminal. Install/enable only; do not duplicate live workers.
set -euo pipefail
if [[ "${1:-}" != "--install-only" || "$#" != 1 ]]; then
  printf '%s\n' 'Usage: bash deploy/systemd/install.sh --install-only' 'Installs and enables units; does not start or stop application processes.'
  exit 2
fi
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$repo_dir" != /home/quant/repos/market-watch ]]; then
  printf '%s\n' 'Service paths are specific to /home/quant/repos/market-watch; review units before installing elsewhere.' >&2
  exit 1
fi
unit_dir="$HOME/.config/systemd/user"
units=(trading-alerts-api.service trading-alerts-market.service trading-alerts-imports.service trading-alerts-notify.service trading-alerts-backup.service trading-alerts-backup.timer)
systemd-analyze --user verify "${units[@]/#/$repo_dir/deploy/systemd/}"
mkdir -p "$unit_dir"
saved_dir="$repo_dir/backups/systemd-units-$(date -u +%Y%m%dT%H%M%S%N)"
for unit in "${units[@]}"; do
  if [[ -e "$unit_dir/$unit" || -L "$unit_dir/$unit" ]]; then
    mkdir -p "$saved_dir"
    cp -P "$unit_dir/$unit" "$saved_dir/$unit"
  fi
  install -m 0644 "$repo_dir/deploy/systemd/$unit" "$unit_dir/$unit"
done
systemctl --user daemon-reload
systemctl --user enable trading-alerts-api.service trading-alerts-market.service trading-alerts-imports.service trading-alerts-notify.service trading-alerts-backup.timer
systemctl --user is-enabled trading-alerts-api.service trading-alerts-market.service trading-alerts-imports.service trading-alerts-notify.service trading-alerts-backup.timer
loginctl show-user "$(id -un)" -p Linger
printf '%s\n' 'Installed and enabled. Current development processes are unchanged. Coordinate stopping them before starting the new services.'
