"""Real transport idle/reuse comparison in the isolated acceptance API container."""

import json
import time

from alerts import provider_chart, provider_transport
from alerts.config import settings


def request(source, client, phase):
    phases = []
    params = ({'symbol': 'BTCUSDT', 'interval': '1m', 'limit': 200} if source == 'binance'
              else {'granularity': 'M1', 'price': 'B', 'count': 200})
    url = (provider_transport.ORIGINS[source] + '/api/v3/klines' if source == 'binance'
           else provider_transport.ORIGINS[source] + '/v3/instruments/EUR_USD/candles')
    headers = {} if source == 'binance' else {'Authorization': 'Bearer ' + settings.oanda_token}
    began = time.monotonic()
    record = {'source': source, 'phase': phase}
    try:
        with provider_transport.activity(client) as client:
            response = client.get(url, params=params, headers=headers, timeout=4,
                                  extensions={'trace': lambda name, info: phases.append(name)})
        record['status'] = response.status_code
    except Exception as error:
        record['error_type'] = type(error).__name__
    record.update(elapsed_ms=round((time.monotonic() - began) * 1000, 2),
                  new_connection=any('connect_tcp.started' in p for p in phases), phases=phases)
    print(json.dumps(record), flush=True)


def main():
    clients = {source: provider_transport.pooled_client(source) for source in ('binance', 'oanda')}
    for source, client in clients.items():
        request(source, client, 'initial')
    provider_transport.start(lambda _: False)
    try:
        for waited in (20, 40, 60, 80):
            time.sleep(20)
            print(json.dumps({'phase': 'idle', 'seconds': waited}), flush=True)
        for source, client in clients.items():
            request(source, client, 'after_80_seconds')
    finally:
        provider_transport.close_clients()


if __name__ == '__main__':
    main()
