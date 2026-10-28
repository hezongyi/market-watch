#!/bin/sh
set -eu
cd /mnt/user/appdata/market-watch
exec 9>/mnt/user/backup/market-watch/.backup.lock
flock -n 9 || exit 0
active_release=$(cat deploy/active-release)
printf '%s\n' "$active_release" | grep -Eq '^releases/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?-[0-9a-f]{7,40}$' || exit 1
test -x "$active_release/compose.sh"
"$active_release/compose.sh" run --rm --no-deps backup
./deploy/unraid-config-backup.sh
