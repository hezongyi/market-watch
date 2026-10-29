#!/bin/sh
set -eu
cd /mnt/user/appdata/market-watch
backup_dir=/mnt/user/backup/market-watch
exec 9>"$backup_dir/.backup.lock"
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
# Retention is count-based and runs even after a failed dump: nothing new piles up
# that night and the keep window must still hold. It never changes $rc.
# Glob order is time order because every name is <prefix>-<UTC timestamp>Z...;
# never parse ls, and never touch anything but direct children of the directory.
# Exempt: market-watch-*.dump (release/rollback evidence) cannot match
# alerts-*.dump, so only config-v* (version-named archives) needs an explicit skip.
rot_delete() {  # path
  rot_size=$(wc -c < "$1" | tr -d ' ')
  printf 'rotation: remove %s (%s bytes)\n' "${1##*/}" "$rot_size"
  if [ "$rot_dry_run" != 1 ]; then
    rm -f "$1" || return 1
  fi
  rot_files=$((rot_files + 1))
  rot_bytes=$((rot_bytes + rot_size))
}
rotate_series() {  # directory pattern companion keep
  rot_dir=$1
  rot_pattern=$2
  rot_companion=$3
  rot_keep=$4
  rot_kept=0
  rot_count=0
  # A glob with no match stays literal; -f filters it out.
  for rot_path in "$rot_dir"/$rot_pattern; do
    [ -f "$rot_path" ] || continue
    case ${rot_path##*/} in
      config-v*) continue ;;
    esac
    rot_count=$((rot_count + 1))
  done
  if [ "$rot_keep" -eq 0 ]; then
    rot_kept=$rot_count
    return 0
  fi
  if [ "$rot_count" -le "$rot_keep" ]; then
    rot_kept=$rot_count
    return 0
  fi
  rot_remove=$((rot_count - rot_keep))
  for rot_path in "$rot_dir"/$rot_pattern; do
    [ -f "$rot_path" ] || continue
    case ${rot_path##*/} in
      config-v*) continue ;;
    esac
    [ "$rot_remove" -gt 0 ] || break
    rot_remove=$((rot_remove - 1))
    rot_delete "$rot_path" || return 1
    if [ -f "$rot_path$rot_companion" ]; then
      rot_delete "$rot_path$rot_companion" || return 1
    fi
  done
  rot_kept=$rot_keep
}
rotate() {  # directory
  rot_dry_run=${MW_BACKUP_ROTATE_DRY_RUN:-0}
  rot_files=0
  rot_bytes=0
  rotate_series "$1" 'alerts-*.dump' '.json' "${MW_BACKUP_KEEP_DAILY:-14}" || return 1
  rot_kept_dumps=$rot_kept
  rotate_series "$1" 'config-*.tar.gz' '.sha256' "${MW_BACKUP_KEEP_CONFIG:-14}" || return 1
  rot_kept_configs=$rot_kept
  if [ "$rot_dry_run" = 1 ]; then
    printf 'rotation(dry-run): would remove %s files (%s bytes); kept %s dumps, %s configs\n' \
      "$rot_files" "$rot_bytes" "$rot_kept_dumps" "$rot_kept_configs"
  else
    printf 'rotation: removed %s files (%s bytes); kept %s dumps, %s configs\n' \
      "$rot_files" "$rot_bytes" "$rot_kept_dumps" "$rot_kept_configs"
  fi
}
rotate "$backup_dir" || printf 'rotation failed\n' >&2
exit $rc
