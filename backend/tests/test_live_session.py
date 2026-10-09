"""Finite session expiry, official boundary interiors, and DST-safe scheduling."""
import hashlib
import importlib.util
from datetime import datetime
from pathlib import Path

from alerts.live_session import session_status
from alerts.market_contracts import DatasetIdentity


def generator():
    spec = importlib.util.spec_from_file_location('live_session_generator',
        Path(__file__).parents[2] / 'scripts/oanda_live_sessions.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.generate


def at(value):
    return int(datetime.fromisoformat(value).timestamp()*1000)


def test_gold_forex_boundaries_and_expiry_do_not_certify_history_or_24x7_sources():
    scope = 'sha256:' + hashlib.sha256(b'test-account').hexdigest()
    profiles = generator()(scope, datetime.fromisoformat('2026-10-09T00:00:00+00:00'),
                           datetime.fromisoformat('2026-10-12T00:00:00+00:00'), ['EUR_USD', 'XAU_USD'])
    for symbol, end in [('EUR_USD', '2026-10-11T21:04:00+00:00'), ('XAU_USD', '2026-10-11T22:04:00+00:00')]:
        identity = DatasetIdentity(source='oanda', channel='v20', environment='practice',
            account_scope=scope, provider_symbol=symbol, basis='bid', calendar_version='candidate').model_dump()
        status = session_status(identity, profiles[symbol], at('2026-10-10T04:00:00+00:00'))
        assert status['market_session'] == 'closed' and status['next_session_at'] == at(end)
        assert session_status(identity, profiles[symbol], at(end))['market_session'] == 'scheduled_open'
        assert session_status(identity, profiles[symbol], at('2026-10-12T00:00:00+00:00'))['market_session'] == 'unknown'
        assert session_status(identity | {'source': 'other'}, profiles[symbol], at(end)-60000)['market_session'] == 'unknown'
        assert profiles[symbol]['closures'] == []  # This status proof adds no minute coverage.


def test_weekend_reopening_after_dst_shift_uses_source_timezone():
    scope = 'sha256:' + hashlib.sha256(b'test-account').hexdigest()
    profile = generator()(scope, datetime.fromisoformat('2026-10-30T00:00:00+00:00'),
        datetime.fromisoformat('2026-11-03T00:00:00+00:00'), ['EUR_USD'])['EUR_USD']
    identity = DatasetIdentity(source='oanda', channel='v20', environment='practice', account_scope=scope,
        provider_symbol='EUR_USD', basis='bid', calendar_version='candidate').model_dump()
    status = session_status(identity, profile, at('2026-10-31T04:00:00+00:00'))
    assert status['next_session_at'] == at('2026-11-01T22:04:00+00:00')
