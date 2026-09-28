#!/bin/sh
# Private application configuration/source archive, separate from PostgreSQL dumps.
set -eu
umask 077
cd /mnt/user/appdata/trading-alerts
backup_dir=/mnt/user/backup/trading-alerts
exec 8>"$backup_dir/.configuration-backup.lock"
flock -n 8 || exit 0
archive_tmp=$(mktemp "$backup_dir/config-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.tar.gz.tmp")
trap 'rm -f "$archive_tmp"' EXIT
tar --exclude=node_modules --exclude=__pycache__ --exclude=.pytest_cache \
  --exclude=.ruff_cache --exclude=dist --exclude=test-results \
  -czf "$archive_tmp" \
  .env compose.external-db.yaml compose.release.yaml \
  Dockerfile pyproject.toml requirements.lock alembic.ini \
  backend migrations web adapters deploy
tar -tzf "$archive_tmp" >/dev/null
archive=${archive_tmp%.tmp}
mv "$archive_tmp" "$archive"
sha256sum "$archive" >"$archive.sha256"
printf 'Configuration/source backup: %s\n' "$archive"
