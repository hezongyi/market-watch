#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_file="${1:?Pass the backup file to verify}"
test -s "$backup_file"
# Always restore to a fresh disposable database; never overwrite alerts.
restore_db="restore_check_$(date +%s)"
docker compose exec -T postgres createdb -U alerts "$restore_db"
trap 'docker compose exec -T postgres dropdb -U alerts "$restore_db"' EXIT
docker compose exec -T postgres pg_restore -U alerts --exit-on-error -d "$restore_db" < "$backup_file"
docker compose exec -T postgres psql -U alerts -d "$restore_db" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS watches FROM watches; SELECT count(*) AS signals FROM signals;'
