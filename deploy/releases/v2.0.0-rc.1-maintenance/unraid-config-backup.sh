#!/bin/sh
# Private application configuration/source archive, separate from PostgreSQL dumps.
set -eu
umask 077
cd /mnt/user/appdata/market-watch
backup_dir=/mnt/user/backup/market-watch
exec 8>"$backup_dir/.configuration-backup.lock"
flock -n 8 || exit 0
archive_tmp=$(mktemp "$backup_dir/config-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.tar.gz.tmp")
trap 'rm -f "$archive_tmp"' EXIT
active_release=$(cat deploy/active-release)
printf '%s\n' "$active_release" | grep -Eq '^releases/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?-[0-9a-f]{7,40}$' || {
  printf 'Invalid active release path\n' >&2; exit 1;
}
test -d "$active_release"
tar --exclude=node_modules --exclude=__pycache__ --exclude=.pytest_cache \
  --exclude=.ruff_cache --exclude=dist --exclude=test-results --exclude=validation \
  --exclude='*.log' --exclude=images.tar.gz --exclude=source-with-licensed-library.tar.gz \
  -czf "$archive_tmp" .env compose.external-db.yaml compose.release.yaml deploy "$active_release"
tar -tzf "$archive_tmp" >/dev/null
archive=${archive_tmp%.tmp}
mv "$archive_tmp" "$archive"
sha256sum "$archive" >"$archive.sha256"
printf 'Configuration/source backup: %s\n' "$archive"
