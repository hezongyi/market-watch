"""Restore an existing production backup only in this Ubuntu project's PG14.

Private dump and manifest stay ignored; public report contains hashes/counts.
The random restore DB is never connected to collectors and is dropped in finally.
"""

import hashlib
import json
import shlex
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ["docker", "compose", "--env-file", "artifacts/data-integration/compose.env",
           "-p", "market-watch-data-integration", "-f", "docs/verification/data-integration/compose.yaml"]


def command(arguments, *, data=None):
    return subprocess.run(["sg", "docker", "-c", shlex.join(COMPOSE + arguments)], cwd=ROOT,
                          input=data, capture_output=True, timeout=300, check=True).stdout


def main():
    dump = ROOT / "artifacts/data-integration/legacy-production.dump"
    manifest = json.loads(dump.with_name(dump.name + ".json").read_text())
    checksum = hashlib.file_digest(dump.open("rb"), "sha256").hexdigest()
    if manifest["sha256"] != checksum or manifest["backend"] != "postgresql":
        raise ValueError("Backup checksum/backend verification failed")
    name = "integration_legacy_restore_" + uuid.uuid4().hex
    report = {"host": "Ubuntu local Docker PostgreSQL14", "project": "market-watch-data-integration",
              "source": "existing unraid backup; production read-only copy",
              "backup_sha256": checksum, "backup_bytes": dump.stat().st_size,
              "backup_created_at": manifest["created_at"], "restore_database": name,
              "verified": False, "cleaned": False}
    created = False
    try:
        command(["exec", "-T", "postgres", "createdb", "-U", "integration", "-T", "template0", name])
        created = True
        command(["exec", "-T", "postgres", "pg_restore", "-U", "integration", "--exit-on-error",
                 "--no-owner", "--no-privileges", "-d", name], data=dump.read_bytes())
        counts = {}
        for table in manifest["counts"]:
            if not table.replace("_", "").isalnum():
                raise ValueError("Unexpected manifest table identifier")
            count = command(["exec", "-T", "postgres", "psql", "-U", "integration", "-d", name,
                             "-At", "-c", f'SELECT count(*) FROM "{table}"'])
            counts[table] = int(count)
        report["restored_counts"] = counts
        if counts != manifest["counts"]:
            raise ValueError("Restored table counts differ from the backup snapshot")
        report["verified"] = True
    finally:
        if created:
            command(["exec", "-T", "postgres", "dropdb", "-U", "integration", name])
            report["cleaned"] = True
        (ROOT / "docs/verification/data-integration/production-backup-ubuntu-restore.json").write_text(
            json.dumps(report, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != "restored_counts"}))


if __name__ == "__main__":
    main()
