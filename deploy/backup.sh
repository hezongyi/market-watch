#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_dir="${1:-./backups}"
mkdir -p "$backup_dir"
umask 077
backup_file="$backup_dir/alerts-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres pg_dump -U alerts -d alerts -Fc > "$backup_file.tmp"
test -s "$backup_file.tmp"
mv "$backup_file.tmp" "$backup_file"
printf '%s\n' "$backup_file"
