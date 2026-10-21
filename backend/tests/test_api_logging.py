"""Exercise diagnostics under the shipped API server's logging defaults."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize('log_level', [None, 'info'])
def test_uvicorn_api_emits_redacted_snapshot_rejection_to_stderr(tmp_path, log_level):
    backend = Path(__file__).resolve().parents[1]
    script = '''
import importlib
import json
import logging
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from uvicorn import Config

Config('alerts.api:app', log_level=LOG_LEVEL).load()
from alerts import api
from alerts.display_snapshots import DisplaySnapshotError
from alerts.provider_display_snapshots import resolve
from alerts.storage import Preference, ProviderDataset

# Repeat application initialization must not duplicate diagnostic handlers.
importlib.reload(api)
engine = create_engine('sqlite://')
Preference.__table__.create(engine)
ProviderDataset.__table__.create(engine)
with Session(engine) as db:
    try:
        resolve(db, 'private-display-credential', 'private-provider-account')
    except DisplaySnapshotError as error:
        print(json.dumps({'attempt_ref': error.attempt_ref, 'code': error.code}))
    else:
        raise AssertionError('missing credential was accepted')

# Enabling these diagnostics must not enable unrelated request/payload logs.
logging.getLogger('httpx').info('private-http-request')
logging.getLogger('alerts.provider_service').info('private-provider-payload')
assert logging.getLogger().getEffectiveLevel() == logging.WARNING
'''.replace('LOG_LEVEL', repr(log_level))
    result = subprocess.run(
        [sys.executable, '-c', script], cwd=tmp_path,
        env={**os.environ, 'PYTHONPATH': str(backend), 'ALERTS_DATABASE_URL': 'sqlite://'},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    response = json.loads(result.stdout)
    assert response['code'] == 'DISPLAY_SNAPSHOT_EXPIRED'
    lines = [line for line in result.stderr.splitlines()
             if 'provider-display-snapshot-rejected ' in line]
    assert len(lines) == 1, result.stderr
    entry = json.loads(lines[0].split('provider-display-snapshot-rejected ', 1)[1])
    assert entry == {
        'attempt_ref': response['attempt_ref'],
        'credential_ref': hashlib.sha256(b'private-display-credential').hexdigest()[:16],
        'reason': 'missing',
        'snapshot_revision': None,
        'current_revision': None,
    }
    assert len(entry['attempt_ref']) == 32
    for private in ('private-display-credential', 'private-provider-account',
                    'private-http-request', 'private-provider-payload'):
        assert private not in result.stdout + result.stderr
