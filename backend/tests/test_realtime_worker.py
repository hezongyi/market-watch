from types import SimpleNamespace

from alerts import market, realtime_worker
from alerts.storage import ChartHistoryPlan, ChartViewportDemand, ImportJob, Instrument, Preference


def test_realtime_switch_off_gates_active_viewport_collection(database, monkeypatch):
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
    assert eur in calls and gold not in calls and btc not in calls
    calls.clear()
    market.once(fetcher=fetch)
    assert eur in calls and gold not in calls


def test_handled_collection_fault_stays_visible_until_its_source_recovers(database, monkeypatch):
    monkeypatch.setattr(realtime_worker.settings, "oanda_acquisition_mode", "stream")
    monkeypatch.setattr(market, "ingest", lambda *_args, **_kwargs: market.Ingestion(0, False))
    monkeypatch.setattr(market, "queue_recovery", lambda *_: None)
    states = []
    with database.begin() as db:
        db.get(Instrument, "BTCUSDT").enabled = False
        gold = db.get(Instrument, "XAUUSD")
        gold.source = "binance"
        gold_symbol = gold.symbol

    def fetch(_source, symbol, *_args, **_kwargs):
        if symbol == gold_symbol and not states:
            raise TimeoutError("private-token")
        return {"rows": []}

    once = market.once
    monkeypatch.setattr(realtime_worker, "once", lambda **kwargs: once(
        **dict(kwargs, fetcher=fetch)))
    monkeypatch.setattr(realtime_worker, "progress", lambda **value: states.append(value))
    stopped = SimpleNamespace(is_set=lambda: len(states) == 3)

    def retry(_delay):
        with database.begin() as db:
            if len(states) == 1:
                db.add(Preference(key="market_backoff:binance", value={"until": market.now_ms() + 60000}))
            elif len(states) == 2:
                db.delete(db.get(Preference, "market_backoff:binance"))

    stopped.wait = retry
    realtime_worker.run(stopped)
    assert states == [dict(state="degraded", error="collection_failed"),
                      dict(state="degraded", error="collection_failed"),
                      dict(state="idle", error=None)]


def test_realtime_import_error_scope_excludes_history_disabled_and_other_sources(database):
    with database.begin() as db:
        db.get(Instrument, "EURUSD").error = "private-token"
        db.get(Instrument, "EURUSD").enabled = False
        db.get(Instrument, "XAUUSD").source = "oanda"
        db.get(Instrument, "XAUUSD").error = "private-token"
        job = ImportJob(instrument_id="BTCUSDT", start=0, end=60000, cursor=0,
                        priority=100, error="private-token", next_at=market.now_ms() + 60000)
        db.add(job)
        db.flush()
        ident = job.id
    assert market.realtime_error(("binance", "dukascopy")) is None
    with database.begin() as db:
        db.get(ImportJob, ident).priority = 0
    assert market.realtime_error(("binance", "dukascopy")) == "import_failed"
    with database.begin() as db:
        db.add(ChartHistoryPlan(instrument_id="BTCUSDT", target_start=0,
                               target_end=60000, realtime_enabled=False))
    assert market.realtime_error(("binance", "dukascopy")) is None
