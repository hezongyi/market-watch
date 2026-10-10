"""Read-only status acceptance against the dedicated Ubuntu fixture database.

This seeds synthetic state only after checking the exact acceptance configuration.
No workers, upstream connections, notifications or production databases are used.
"""
import hashlib
import json

from alerts import live_api, live_pricing
from alerts.config import settings
from alerts.storage import LiveState, MarketDemand, Preference, PricingOwner, now_ms, transaction
from sqlalchemy import select


def main():
    assert settings.database_application_name in {
        'mw-source-status-20261010', 'mw-source-status-delivery-20261010'
    }
    assert settings.database_url.split('@')[-1] == 'pg/source_status'
    assert settings.oanda_account_id == 'source-status-acceptance-account'
    assert not settings.delivery_enabled and not settings.oanda_stream_enabled
    catalog = [{'name': 'EUR_USD', 'displayPrecision': 5},
               {'name': 'XAU_USD', 'displayPrecision': 3}]
    stamp = now_ms()
    for account in [settings.oanda_account_id, 'other-source-status-acceptance-account']:
        live_pricing.ensure_catalog(catalog, account)
        identities = live_pricing.desired_datasets(account)
        owner = live_pricing.claim(account, now=stamp)
        assert owner is not None
        live_pricing.begin_connection(owner, identities, now=stamp)
        with transaction() as db:
            for identity in identities.values():
                state = db.get(LiveState, identity.key)
                state.connection = 'connected'
                state.heartbeat_at = stamp
                state.received_at = stamp
                state.quote = {'bid': '1.10', 'ask': '1.11', 'tradeable': True,
                               'source_time': stamp}
                state.ready = True
                state.confirmed_end = stamp // 60000 * 60000

    def fingerprint():
        with transaction() as db:
            values = {}
            for model in [LiveState, MarketDemand, PricingOwner, Preference]:
                values[model.__tablename__] = sorted(
                    [dict((col.name, getattr(row, col.name)) for col in model.__table__.columns)
                     for row in db.scalars(select(model))], key=lambda row: json.dumps(row, sort_keys=True))
            return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()

    status = next(route.endpoint for route in live_api.router(lambda: 'acceptance').routes
                  if route.path.endswith('/status'))
    before = fingerprint()
    scope = 'sha256:' + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
    for _ in range(5):
        snapshot = status()
        assert snapshot['provider']['configured'] is True
        assert snapshot['provider']['collection_recorded'] is True
        assert snapshot['provider']['connection_started_at'] == stamp
        assert snapshot['provider']['error_observed_at'] is None
        assert len(snapshot['datasets']) == 2
        assert all(row['identity']['account_scope'] == scope for row in snapshot['datasets'])
        assert all(row['quote_ready'] and row['candle_ready'] for row in snapshot['datasets'])
    assert fingerprint() == before
    print(json.dumps({'environment': 'Ubuntu isolated Docker; actual PostgreSQL 14',
                      'passed': True, 'configured_account_rows': 2, 'other_account_rows_hidden': 2,
                      'repeated_status_reads': 5, 'state_and_demand_fingerprint_unchanged': True,
                      'real_provider_connections': False}, indent=2))


if __name__ == '__main__':
    main()
