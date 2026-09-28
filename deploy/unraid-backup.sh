#!/bin/sh
set -eu
cd /mnt/user/appdata/trading-alerts
exec 9>/mnt/user/backup/trading-alerts/.backup.lock
flock -n 9 || exit 0
docker run --rm --name trading-alerts-backup-run \
  --network trading-alerts_default \
  --env-file .env \
  -e ALERTS_POSTGRES_BIN_DIR=/usr/local/bin \
  -e ALERTS_DELIVERY_ENABLED=false \
  -v /mnt/user/backup/trading-alerts:/backups \
  trading-alerts-backup:20260929-pg14
./deploy/unraid-config-backup.sh
