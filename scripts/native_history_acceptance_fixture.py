"""Restricted local native-history acceptance fixture; never target another DB."""
import argparse
import os
import time
from pathlib import Path

from sqlalchemy import create_engine, delete, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reset', action='store_true')
    parser.add_argument('--buffer', choices=['on', 'off'])
    args = parser.parse_args()
    path = Path('/tmp/mw-native-history/api.env')
    config = dict(line.split('=', 1) for line in path.read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
    url = make_url(config['ALERTS_DATABASE_URL'])
    assert url.host == 'market-watch-native-history-pg' and url.database == 'market_watch_native_history'
    if args.buffer:
        config['ALERTS_PROVIDER_NATIVE_HISTORY_BUFFER'] = str(args.buffer == 'on').lower()
        path.write_text('\n'.join(k + '=' + v for k, v in config.items()) + '\n')
        path.chmod(0o600)
        print('Isolated acceptance buffer flag:', args.buffer)
    if args.reset:
        os.environ['ALERTS_DATABASE_URL'] = url.set(host='127.0.0.1', port=15532).render_as_string(hide_password=False)
        os.environ['ALERTS_DELIVERY_ENABLED'] = 'false'
        from alerts.storage import ProviderBar, ProviderDataset, ProviderInterest, now_ms
        engine = create_engine(os.environ['ALERTS_DATABASE_URL'], pool_size=1, max_overflow=0)
        factory = sessionmaker(engine)
        with factory.begin() as db:
            db.execute(delete(ProviderInterest))
        until = time.monotonic() + 35
        while True:
            with factory.begin() as db:
                busy = db.scalar(select(func.count()).select_from(ProviderDataset)
                                 .where(ProviderDataset.lease_until > now_ms()))
            if not busy:
                break
            if time.monotonic() >= until:
                raise TimeoutError('Existing fixture page did not finish')
            time.sleep(0.1)
        with factory.begin() as db:
            assert not db.scalar(select(func.count()).select_from(ProviderInterest)), 'close browser before reset'
            db.execute(delete(ProviderBar))
            db.execute(delete(ProviderDataset))
        engine.dispose()
        print('Only isolated native-history provider cache reset')


if __name__ == '__main__':
    main()
