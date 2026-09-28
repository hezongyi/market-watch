"""Online SQLite backup with independent integrity and table-count verification."""
import argparse
import json
import os
import sqlite3
from pathlib import Path
from sqlalchemy.engine import make_url
from alerts.config import settings

parser = argparse.ArgumentParser()
parser.add_argument('destination', type=Path)
args = parser.parse_args()
url = make_url(settings.database_url)
if url.get_backend_name() != 'sqlite' or not url.database or url.database == ':memory:':
    parser.error('This tool requires a file-backed SQLite database')
source = Path(url.database).resolve()
destination = args.destination.resolve()
if destination == source or destination.exists():
    parser.error('Destination must be a new file distinct from the source')
if not source.is_file():
    parser.error('Source database does not exist')
destination.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(fd)
try:
    with sqlite3.connect(source.as_uri()+'?mode=ro', uri=True) as src, sqlite3.connect(destination) as dst:
        src.backup(dst)
    with sqlite3.connect(destination.as_uri()+'?mode=ro', uri=True) as restored:
        if restored.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Backup integrity check failed')
        violations = restored.execute('PRAGMA foreign_key_check').fetchall()
        if violations:
            raise RuntimeError('Backup has foreign-key violations')
        counts = {name: restored.execute('SELECT count(*) FROM '+name).fetchone()[0]
                  for name in ['instruments','candles','watches','signals','import_jobs']}
    print(json.dumps({'backup': str(destination), 'integrity': 'ok', 'counts': counts}))
except Exception:
    destination.unlink(missing_ok=True)
    raise
