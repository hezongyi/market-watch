from alerts import market
from alerts.storage import ChartViewportDemand, Instrument


def test_realtime_keeps_maintained_symbols_and_only_active_viewers(database, monkeypatch):
    now = 1790780000000
    monkeypatch.setattr(market, 'now_ms', lambda: now)
    monkeypatch.setattr(market, 'ingest', lambda *args, **kwargs: market.Ingestion(0, False))
    monkeypatch.setattr(market, 'queue_recovery', lambda *args: None)
    with database.begin() as db:
        # Keep one permanent instrument, two demand-only instruments.
        for ident in ('XAUUSD', 'BTCUSDT'):
            inst = db.get(Instrument, ident)
            inst.enabled = False
        db.add(ChartViewportDemand(id='active',instrument_id='XAUUSD',timeframe='H1',
            start=now-60000,end=now,warm_start=now-180000,focused=True,expires=now+1000))
        db.add(ChartViewportDemand(id='closed',instrument_id='BTCUSDT',timeframe='H1',
            start=now-60000,end=now,warm_start=now-180000,focused=True,expires=now-1))
    calls=[]
    def fetch(source, symbol, *args, **kwargs):
        calls.append(symbol)
        return {'rows': []}
    market.once(include_viewers=True,fetcher=fetch)
    with database.begin() as db:
        eur = db.get(Instrument,'EURUSD').symbol
        gold = db.get(Instrument,'XAUUSD').symbol
        btc = db.get(Instrument,'BTCUSDT').symbol
    assert eur in calls and gold in calls and btc not in calls
    assert calls.index(eur) < calls.index(gold)
    calls.clear()
    market.once(fetcher=fetch)
    assert eur in calls and gold not in calls
