#!/bin/sh
set -eu
cd /mnt/user/appdata/market-watch
exec 9>/mnt/user/backup/market-watch/.backup.lock
if ! flock -n 9; then
  printf 'skipped: backup lock held\n'
  exit 0
fi
active_release=$(cat deploy/active-release)
printf '%s\n' "$active_release" | grep -Eq '^releases/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?-[0-9a-f]{7,40}$' || {
  printf 'Invalid active release path\n' >&2; exit 1;
}
test -x "$active_release/compose.sh" || {
  printf 'Missing release compose entrypoint\n' >&2; exit 1;
}
# The dump and the configuration archive are independent: a failed dump must not
# silently skip the config archive, and either failure fails the whole run.
rc=0
"$active_release/compose.sh" run --rm --no-deps backup || {
  printf 'Database backup failed\n' >&2; rc=1;
}
./deploy/unraid-config-backup.sh || {
  printf 'Configuration backup failed\n' >&2; rc=1;
}
exit $rc
