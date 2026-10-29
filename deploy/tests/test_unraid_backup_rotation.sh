#!/bin/sh
# Count-based rotation regression for deploy/unraid-backup.sh.
# Runs the real script against a throwaway appdata/backup tree. The configuration
# archiver is stubbed so the fixture's file set stays deterministic; everything
# else (lock, active release, compose entrypoint, rotation) is the shipped script.
set -u

here=$(cd "$(dirname "$0")" && pwd)
source_script=$here/../unraid-backup.sh
pass=0
fail=0

ok() {
  pass=$((pass + 1))
  printf 'PASS %s\n' "$1"
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL %s\n' "$1"
  if [ $# -gt 1 ]; then printf '     %s\n' "$2"; fi
  if [ $# -gt 2 ]; then printf '     %s\n' "$3"; fi
}

check() {  # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected: $2" "actual:   $3"; fi
}

contains() {  # label needle haystack
  case $3 in
    *"$2"*) ok "$1" ;;
    *) bad "$1" "missing: $2" "output:  $3" ;;
  esac
}

lacks() {  # label needle haystack
  case $3 in
    *"$2"*) bad "$1" "unexpected: $2" ;;
    *) ok "$1" ;;
  esac
}

count_of() {  # directory pattern
  count_n=0
  for count_f in "$1"/$2; do
    [ -f "$count_f" ] || continue
    count_n=$((count_n + 1))
  done
  printf '%s' "$count_n"
}

exists() { [ -f "$1" ] && printf yes || printf no; }

setup() {  # database backup exit status for the fake release entrypoint
  root=$(mktemp -d)
  app=$root/app
  backup=$root/backup
  release=$app/releases/v2.0.0-rc.1-abcdef1
  mkdir -p "$app/deploy" "$release" "$backup"
  sed -e "s#/mnt/user/appdata/market-watch#$app#" \
      -e "s#/mnt/user/backup/market-watch#$backup#" \
      -e "s#\./deploy/unraid-config-backup\.sh#./deploy/stub-config-backup.sh#" \
      "$source_script" > "$root/backup.sh"
  printf 'releases/v2.0.0-rc.1-abcdef1\n' > "$app/deploy/active-release"
  printf '#!/bin/sh\nexit %s\n' "$1" > "$release/compose.sh"
  chmod 755 "$release/compose.sh"
  printf '#!/bin/sh\nexit 0\n' > "$app/deploy/stub-config-backup.sh"
  chmod 755 "$app/deploy/stub-config-backup.sh"
  : > "$backup/.backup.lock"
  printf 'previous run ok\n' > "$backup/latest-run.log"
}

fill() {  # 20 dumps + manifests, 20 config archives + checksums, 3 exemptions
  fill_i=1
  while [ "$fill_i" -le 20 ]; do
    fill_stamp=$(printf '2026%02d01T000000000000Z' "$fill_i")
    printf '0123456789' > "$backup/alerts-$fill_stamp.dump"
    printf '{}' > "$backup/alerts-$fill_stamp.dump.json"
    printf '0123456789' > "$backup/config-$fill_stamp-abc.tar.gz"
    printf 'xx' > "$backup/config-$fill_stamp-abc.tar.gz.sha256"
    fill_i=$((fill_i + 1))
  done
  printf '0123456789' > "$backup/market-watch-v2.0.0-rc.1-20261028.dump"
  printf '0123456789' > "$backup/config-v1.29.1-20261001T000000Z.tar.gz"
  printf '0123456789' > "$backup/config-v2.0.0-rc.1-20261001T000000Z.tar.gz"
}

run_backup() {  # optional environment assignments are passed by the caller
  output=$(sh "$root/backup.sh" 2>&1)
  status=$?
}

teardown() {
  rm -rf "$root"
}

oldest=alerts-20260101T000000000000Z
newest=alerts-20262001T000000000000Z

printf '== default run (keep 14/14) ==\n'
setup 0
fill
run_backup
check 'database backup exit code passes through' 0 "$status"
check '14 newest dumps kept' 14 "$(count_of "$backup" 'alerts-*.dump')"
check 'their manifests kept' 14 "$(count_of "$backup" 'alerts-*.json')"
check 'oldest dump removed' no "$(exists "$backup/$oldest.dump")"
check 'oldest manifest removed with it' no "$(exists "$backup/$oldest.dump.json")"
check '6th oldest dump removed' no "$(exists "$backup/alerts-20260601T000000000000Z.dump")"
check '7th oldest dump kept' yes "$(exists "$backup/alerts-20260701T000000000000Z.dump")"
check 'newest dump kept' yes "$(exists "$backup/$newest.dump")"
check '14 newest config archives kept' 14 "$(count_of "$backup" 'config-2*.tar.gz')"
check '14 config checksums kept' 14 "$(count_of "$backup" 'config-2*.sha256')"
check 'oldest config archive removed' no \
  "$(exists "$backup/config-20260101T000000000000Z-abc.tar.gz")"
check 'oldest config checksum removed with it' no \
  "$(exists "$backup/config-20260101T000000000Z-abc.tar.gz.sha256")"
check 'release evidence dump exempt' yes \
  "$(exists "$backup/market-watch-v2.0.0-rc.1-20261028.dump")"
check 'versioned config archive exempt (release)' yes \
  "$(exists "$backup/config-v1.29.1-20261001T000000Z.tar.gz")"
check 'versioned config archive exempt (rc)' yes \
  "$(exists "$backup/config-v2.0.0-rc.1-20261001T000000Z.tar.gz")"
check 'lock file untouched' yes "$(exists "$backup/.backup.lock")"
check 'log file untouched' 'previous run ok' "$(cat "$backup/latest-run.log")"
contains 'summary counts every removed file' \
  'rotation: removed 24 files (144 bytes); kept 14 dumps, 14 configs' "$output"
contains 'per-file removal line' \
  'rotation: remove alerts-20260101T000000000000Z.dump (10 bytes)' "$output"
contains 'companion removal line' \
  'rotation: remove alerts-20260101T000000000000Z.dump.json (2 bytes)' "$output"
lacks 'no dry-run marker without the switch' 'rotation(dry-run)' "$output"

printf '== second run is idempotent ==\n'
run_backup
check 'second run exit code' 0 "$status"
contains 'second run removes nothing' 'rotation: removed 0 files (0 bytes)' "$output"
check 'still 14 dumps' 14 "$(count_of "$backup" 'alerts-*.dump')"
teardown

printf '== dry-run ==\n'
setup 0
fill
output=$(MW_BACKUP_ROTATE_DRY_RUN=1 sh "$root/backup.sh" 2>&1)
status=$?
check 'dry-run exit code' 0 "$status"
check 'dry-run deletes no dump' 20 "$(count_of "$backup" 'alerts-*.dump')"
check 'dry-run deletes no manifest' 20 "$(count_of "$backup" 'alerts-*.json')"
check 'dry-run deletes no config archive' 20 "$(count_of "$backup" 'config-2*.tar.gz')"
check 'dry-run keeps the oldest dump' yes "$(exists "$backup/$oldest.dump")"
contains 'dry-run summary' \
  'rotation(dry-run): would remove 24 files (144 bytes); kept 14 dumps, 14 configs' "$output"
contains 'dry-run lists candidates' \
  'rotation: remove alerts-20260101T000000000000Z.dump (10 bytes)' "$output"
lacks 'dry-run does not claim removal' 'rotation: removed' "$output"
teardown

printf '== keep 0 disables the series ==\n'
setup 0
fill
output=$(MW_BACKUP_KEEP_DAILY=0 sh "$root/backup.sh" 2>&1)
status=$?
check 'keep 0 exit code' 0 "$status"
check 'keep 0 keeps every dump' 20 "$(count_of "$backup" 'alerts-*.dump')"
check 'keep 0 keeps every manifest' 20 "$(count_of "$backup" 'alerts-*.json')"
check 'keep 0 still trims config archives' 14 "$(count_of "$backup" 'config-2*.tar.gz')"
contains 'keep 0 summary' 'kept 20 dumps, 14 configs' "$output"
teardown

printf '== custom keep ==\n'
setup 0
fill
output=$(MW_BACKUP_KEEP_DAILY=20 MW_BACKUP_KEEP_CONFIG=3 sh "$root/backup.sh" 2>&1)
status=$?
check 'custom keep exit code' 0 "$status"
check 'custom keep keeps all dumps' 20 "$(count_of "$backup" 'alerts-*.dump')"
check 'custom keep trims to 3 configs' 3 "$(count_of "$backup" 'config-2*.tar.gz')"
contains 'custom keep summary' 'kept 20 dumps, 3 configs' "$output"
teardown

printf '== empty backup directory ==\n'
setup 0
run_backup
check 'no-match exit code' 0 "$status"
contains 'no-match summary' \
  'rotation: removed 0 files (0 bytes); kept 0 dumps, 0 configs' "$output"
check 'no-match keeps lock' yes "$(exists "$backup/.backup.lock")"
check 'no-match keeps log' 'previous run ok' "$(cat "$backup/latest-run.log")"
teardown

printf '== rotation still runs when the dump fails ==\n'
setup 1
fill
run_backup
check 'failed dump keeps a non-zero exit code' 1 "$status"
contains 'failed dump is reported' 'Database backup failed' "$output"
check 'failed dump night still trims to 14' 14 "$(count_of "$backup" 'alerts-*.dump')"
check 'failed dump night still trims configs' 14 "$(count_of "$backup" 'config-2*.tar.gz')"
contains 'failed dump night still logs rotation' 'rotation: removed 24 files' "$output"
teardown

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
