set -u
cd /home/quant/repos/market-watch-runtime-track-c-20261028
CP=/home/quant/repos/market-watch/.venv/bin/python
PROJ=mw-track-c-20261028
FILE=deploy/ubuntu/runtime-track-c.acceptance.yaml
OUT=docs/verification/runtime-market-20261026/results/track-c
SCRATCH=/home/quant/tc-scratch
TMPDB=track_c_restore_$(date +%s)
set -x
# 1. maintenance dump through the PostgreSQL image (the backend image has no pg_dump)
docker compose -p $PROJ -f $FILE exec -T postgres bash -c 'pg_dump --format=custom --no-owner -U track_c -d track_c_acceptance -f /tmp/track-c.dump; sha256sum /tmp/track-c.dump; stat -c %s /tmp/track-c.dump'
docker cp $PROJ-postgres-1:/tmp/track-c.dump $SCRATCH/track-c.dump
sha256sum $SCRATCH/track-c.dump
# 2. source row counts through the application helper
docker compose -p $PROJ -f $FILE run --rm --no-deps -T data-worker python /candidate/scripts/track_c_acceptance_run.py g5-counts > $OUT/g5-backup-counts.json
# 3. real restore into a temporary database
docker compose -p $PROJ -f $FILE exec -T postgres psql -U track_c -d postgres -c "CREATE DATABASE $TMPDB TEMPLATE template0"
docker compose -p $PROJ -f $FILE exec -T postgres bash -c "pg_restore --exit-on-error --no-owner --no-privileges -U track_c --dbname $TMPDB /tmp/track-c.dump && echo RESTORE_OK"
# 4. restored row counts through the same application helper
docker compose -p $PROJ -f $FILE run --rm --no-deps -T data-worker python /candidate/scripts/track_c_acceptance_run.py g5-counts --database "postgresql+psycopg://track_c:track_c_acceptance_only@postgres:5432/$TMPDB" > $OUT/g5-restore-counts.json
set +x
$CP - "$OUT" "$TMPDB" <<'PY'
import json, sys
out, tmpdb = sys.argv[1], sys.argv[2]
src = json.load(open(out + "/g5-backup-counts.json"))["counts"]
dst = json.load(open(out + "/g5-restore-counts.json"))["counts"]
same = src == dst
record = {"verified": same, "tables": len(src), "temporary_database": tmpdb,
          "source_counts": src, "restored_counts": dst,
          "differences": {k: [src.get(k), dst.get(k)] for k in set(src) | set(dst) if src.get(k) != dst.get(k)}}
open(out + "/g5-restore-verification.json", "w").write(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
print("tables", len(src), "identical", same)
print("differences", record["differences"])
PY
docker compose -p $PROJ -f $FILE exec -T postgres psql -U track_c -d postgres -c "DROP DATABASE $TMPDB"
docker compose -p $PROJ -f $FILE exec -T postgres rm -f /tmp/track-c.dump