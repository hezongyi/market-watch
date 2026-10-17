"""Synthetic inputs for #74's named PostgreSQL, with real import/publication APIs."""

import json
import math
from decimal import Decimal

from sqlalchemy.engine import make_url

from alerts.config import settings
from alerts.storage import (AdvancedWorkspace, ChartPublication, ChartPublishedBar,
                            HistoryVersion, Instrument, MarketCatalog, Preference,
                            ProviderDataset, bootstrap, now_ms, transaction)

MARKER = 'acceptance.indicator-parity.20261017'


def seed():
    url = make_url(settings.database_url)
    if (url.host != 'pg' or url.database != 'indicator_parity' or url.username != 'indicator_parity'
            or settings.database_application_name != 'mw-issue74-20261017'
            or settings.delivery_enabled or settings.oanda_token or settings.yahoo_enabled):
        raise RuntimeError('Requires the isolated #74 PostgreSQL and disabled external delivery/suppliers')
    bootstrap()
    with transaction() as db:
        old = db.get(Preference, MARKER)
        if old:
            print(json.dumps(old.value))
            return
        if db.get(Instrument, 'PARITY'):
            raise RuntimeError('Incomplete fixture exists; inspect it before attempting another seed')
        db.add(Instrument(id='PARITY', symbol='PARITY', label='指标验收 · 合成行情',
            source='binance', calendar='utc0', basis='last', precision=5, enabled=False,
            calendar_profile={}))
        db.flush()
        end = now_ms() // 60000 * 60000
        for frame, width in (('M1',60000), ('H1',3600000)):
            right = end // width * width
            left = right - 2400 * width
            for index, at in enumerate(range(left, right, width)):
                price = Decimal(str(round(100 + math.sin(index / 7) * 5 + index / 100, 5)))
                db.add(ChartPublishedBar(instrument_id='PARITY',timeframe=frame,start=at,end=at+width,
                    complete=True,revision=1,payload=dict(start=at,end=at+width,chart_time=at,
                    open=str(price),high=str(price+2),low=str(price-2),close=str(price+1),
                    complete=True,volume='10',volume_complete=True)))
            db.add(ChartPublication(instrument_id='PARITY',timeframe=frame,start=left,end=right,
                complete_count=2400,initialized=True,revision=1))

    from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
    from alerts.market_datasets import register_dataset
    from alerts import history_versions as history
    from alerts.history_artifacts import artifact_tick, request_artifacts
    identity = DatasetIdentity(source='dukascopy',channel='python',environment='historical',
        account_scope='public',provider_symbol='EUR/USD',basis='bid',
        calendar_version='indicator-parity-synthetic-ny17-v1')
    with transaction() as db:
        inst = register_dataset(db,identity,logical_symbol='EURUSD',label='固定历史 · 合成输入',
            calendar='ny17',precision=5,volume_kind='quantity',volume_unit='source_quantity')
        instrument, dataset_id = inst.id, identity.key
        start, end = 1791158400000, 1791504000000  # 2026-10-05..09 UTC
        version = history.create_version(db,dataset_id,start,end)

    class SyntheticAdapter:
        def page(self, identity, start, end):
            rows = []
            for at in range(start,end,60000):
                index = (at - 1791158400000) // 60000
                price = Decimal('1.10') + Decimal(index % 503) / Decimal('100000')
                rows.append(MinuteRow(timestamp=at,open=str(price),high=str(price+Decimal('.0002')),
                    low=str(price-Decimal('.0002')),close=str(price+Decimal('.0001')),
                    volume='10',complete=True))
            return CandleBatch(identity=identity,window_start=start,window_end=end,observed_at=end+60000,
                result=RequestResult(status='data'),rows=tuple(rows),checkpoint=end,
                volume_kind='quantity',volume_unit='source_quantity')

    for _ in range(100):
        history.import_page(SyntheticAdapter(),version_id=version)
        with transaction() as db:
            current = db.get(HistoryVersion,version)
            if current.error:
                raise RuntimeError(current.error)
            if current.status == 'published':
                request_artifacts(db,current,['M1','H1'])
                break
    else:
        raise RuntimeError('Synthetic import did not publish')
    while artifact_tick(version):
        pass

    from alerts.composite_definitions import first_use, save_mapping
    from alerts.history_catalog import account_scope
    settings.oanda_account_id = 'indicator-parity-synthetic'
    settings.oanda_token = 'synthetic-no-network-access'
    try:
        with transaction() as db:
            catalog_id = 'HC:' + '7' * 36
            db.add(MarketCatalog(id=catalog_id,source='oanda',symbol='EUR_USD',label='组合目标 · 合成输入',
                asset_type='CURRENCY',precision=5,calendar='ny17',
                metadata_json={'history_account_scope':account_scope()}))
            db.flush()
            mapping = save_mapping(db,dataset_id,catalog_id,dict(underlying='EUR',quote_currency='USD',
                historical_product='spot_fx',live_product='spot_fx',relationship='same_product',
                historical_evidence='https://example.invalid/parity-history',
                live_evidence='https://example.invalid/parity-live',reviewed=True,
                rationale='Synthetic isolated fixture only; no supplier equivalence or real quote claim'))
            composite = first_use(db,dataset_id,mapping.id)
            composite_id = composite.id
    finally:
        settings.oanda_token = ''

    from alerts import provider_cache as cache
    from alerts.provider_chart import metadata
    stamp = now_ms()
    for frame,width in (('M1',60000),('H1',3600000)):
        right = stamp // width * width
        rows = []
        for index,at in enumerate(range(right-2400*width,right,width)):
            price = 100 + math.sin(index / 7) * 5 + index / 100
            rows.append(dict(start=at,end=at+width,chart_time=at,open=str(price),high=str(price+2),
                low=str(price-2),close=str(price+1),complete=True,volume='10',
                volume_kind='quantity',volume_unit='source_quantity'))
        key = cache.ensure(metadata('BTCUSDT'),frame)
        owner = cache.claim(key)
        if owner is None:
            raise RuntimeError('Synthetic provider input already leased')
        cache.commit_page(key,owner,{'bars':rows,'history_boundary':True},right,stamp,latest=True)
        cache.release(key,owner)
        with transaction() as db:
            db.get(ProviderDataset,key).latest_at = stamp + 3600000

    from alerts.chart_series import encode
    series = {'provider':'MWP:BTCUSDT','managed':'PARITY',
              'history':encode(version,'history'),'composite':encode(composite_id,'composite')}
    result = dict(synthetic=True,series=series,history_version=version,history_instrument=instrument,
                  history_start=start,history_end=end,provider_cache_valid_until=stamp+3600000)
    with transaction() as db:
        for kind,symbol in series.items():
            db.add(AdvancedWorkspace(id='parity-'+kind,name=kind+' · 指标性能验收',
                document={'engine':'tv31','schemaVersion':1,'symbol':symbol,
                          'series_kind':kind,'interval':'1'}))
        db.add(Preference(key=MARKER,value=result))
    print(json.dumps(result))


if __name__ == '__main__':
    seed()
