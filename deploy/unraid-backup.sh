#!/bin/sh
set -eu
cd /mnt/user/appdata/trading-alerts
exec 9>/mnt/user/backup/trading-alerts/.backup.lock
flock -n 9 || exit 0
./tools/docker-compose -f compose.release.yaml run --rm --no-deps backup
./deploy/unraid-config-backup.sh
