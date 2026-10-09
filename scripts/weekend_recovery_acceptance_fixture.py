"""Controlled status-only fixture; refuses production, never contacts a supplier."""
import argparse
import json

from alerts.config import settings
from alerts.live_pricing import account_key, desired_datasets, ensure_catalog
from alerts.storage import LiveState, Preference, PricingOwner, now_ms, transaction
from sqlalchemy.engine import make_url

TASK = 'mw-weekend-recovery-20261010'
ACCOUNT = 'weekend-recovery-synthetic'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['startup-auth', 'auth', 'maintenance', 'closed', 'recovering', 'unknown', 'cleanup'])
    phase = parser.parse_args().phase
    url = make_url(settings.database_url)
    if (settings.database_application_name != TASK or settings.oanda_account_id != ACCOUNT
            or url.host != 'postgres' or url.database != 'alerts' or settings.delivery_enabled):
        raise SystemExit('Refusing any database outside the owned Ubuntu recovery task')
    if phase not in ('startup-auth', 'cleanup'):
        ensure_catalog([{'name': 'EUR_USD', 'displayName': 'SYNTHETIC status fixture EUR/USD', 'displayPrecision': 5},
                        {'name': 'XAU_USD', 'displayName': 'SYNTHETIC status fixture gold', 'displayPrecision': 3}], ACCOUNT)
    identities = desired_datasets(ACCOUNT)
    stamp = now_ms()
    key = account_key(ACCOUNT)
    with transaction() as db:
        owner = db.get(PricingOwner, key)
        if phase == 'cleanup':
            for identity in identities.values():
                state = db.get(LiveState, identity.key)
                state.connection, state.error, state.ready = 'inactive', None, False
                state.revision += 1
            if owner:
                db.delete(owner)
            return
        if not owner:
            owner = PricingOwner(id=key)
            db.add(owner)
        owner.epoch = max(owner.epoch or 0, 1)
        owner.token = 'synthetic-recovery-owner' if phase == 'recovering' else None
        owner.expires = stamp + 60000 if phase == 'recovering' else 0
        owner.next_at = stamp + 300000
        owner.error = 'unauthorized' if phase in ('auth', 'startup-auth', 'maintenance') else None
        owner.failures = 1 if owner.error else 0
        db.merge(Preference(key='oanda_probe_status:' + key,
            value={'error': 'provider_maintenance' if phase == 'maintenance' else None, 'observed_at': stamp}))
        for symbol, identity in identities.items():
            state = db.get(LiveState, identity.key)
            state.epoch = owner.epoch
            state.connection = 'recovering' if phase == 'recovering' else 'closed' if phase == 'closed' else 'disconnected'
            state.error = 'unauthorized' if owner.error else None
            state.ready = False
            state.heartbeat_at = stamp if phase == 'recovering' else 0
            state.quote, state.forming = {}, {}
            state.revision += 1
    print(json.dumps({'synthetic': True, 'phase': phase, 'datasets': len(identities), 'task': TASK}))


if __name__ == '__main__':
    main()
