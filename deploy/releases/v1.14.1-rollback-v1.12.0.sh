#!/bin/sh
# Formal application rollback. Keep additive schema and raw proofs.
set -eu
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml stop -t 30 api realtime-worker chart-history-worker chart-aggregation-worker native-history-worker notify-worker history-worker composite-aggregate-worker
./tools/docker-compose -p market-watch -f compose.release.yaml run --rm --no-deps -T api python -m alerts.publication_admin prepare-rollback --workers-stopped
cp releases/v1.14.1-6fd9273/rollback-v1.12.0-compose.yaml compose.release.yaml.next
chmod 600 compose.release.yaml.next
mv compose.release.yaml.next compose.release.yaml
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps --wait api chart-origin
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps web realtime-worker chart-history-worker chart-aggregation-worker native-history-worker notify-worker
printf '%s\n' releases/v1.12.0-0591e56 > deploy/active-release.next
mv deploy/active-release.next deploy/active-release
# Remove stopped services belonging only to this newer release; preserve all images/data.
./tools/docker-compose -p market-watch -f releases/v1.14.1-6fd9273/compose.release.yaml --project-directory /mnt/user/appdata/market-watch rm -f history-worker composite-aggregate-worker
