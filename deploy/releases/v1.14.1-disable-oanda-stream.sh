#!/bin/sh
set -eu
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml stop -t 30 pricing-worker
./tools/docker-compose -p market-watch -f compose.release.yaml rm -f pricing-worker
cp releases/v1.14.1-6fd9273/compose.stream-disabled.yaml compose.release.yaml.next
chmod 600 compose.release.yaml.next
mv compose.release.yaml.next compose.release.yaml
cp compose.release.yaml releases/v1.14.1-6fd9273/compose.release.yaml
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps --wait api
