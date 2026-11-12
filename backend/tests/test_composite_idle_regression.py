"""Real enabled heads keep collecting; empty workers leave no scheduling writes."""
from alerts import display_indicator_jobs, fixed_indicators, live_pricing, oanda_worker
from alerts.config import settings
from alerts.storage import IndicatorSchedule, Instrument, MarketDataset
from sqlalchemy import event, select
from test_idle_worker_costs import Stop
from test_market_contracts import identity
from test_market_usage import ready


def test_enabled_head_collects_without_browser_and_stops_on_disable(database, monkeypatch):
    ready(database, monkeypatch)
    assert set(live_pricing.desired_datasets(settings.oanda_account_id)) == {'EUR_USD'}
    from alerts.realtime_switch import set_enabled
    with database.begin() as db:
        set_enabled(db, db.get(MarketDataset, identity().key).instrument_id, False, now=1)
    assert not live_pricing.desired_datasets(settings.oanda_account_id)


def test_empty_indicator_workers_do_not_write_fairness_turns(database):
    statements = []
    engine = database.kw['bind']
    def record(conn, cursor, statement, *args):
        if statement.lstrip().lower().startswith(('insert', 'update')) and 'indicator_schedule' in statement:
            statements.append(statement)
    event.listen(engine, 'before_cursor_execute', record)
    try:
        for _ in range(3):
            assert fixed_indicators.claim() is None
            assert display_indicator_jobs.tick() is False
        with database() as db:
            assert not list(db.scalars(select(IndicatorSchedule)))
        assert not statements
    finally:
        event.remove(engine, 'before_cursor_execute', record)


def test_pricing_without_demand_does_not_claim_every_idle_round(monkeypatch):
    from types import SimpleNamespace
    claims = []
    monkeypatch.setattr(oanda_worker, 'claim', lambda *a, **kw: claims.append(1) or {'id': 'owner'})
    monkeypatch.setattr(oanda_worker, 'claim_auth_probe', lambda *a, **kw: None)
    monkeypatch.setattr(oanda_worker, 'ensure_catalog', lambda *a, **kw: None)
    monkeypatch.setattr(oanda_worker, 'desired_for_mode', lambda *a: {})
    monkeypatch.setattr(oanda_worker, 'closed_delay', lambda *a: None)
    monkeypatch.setattr(oanda_worker, 'park_closed', lambda *a: None)
    monkeypatch.setattr(oanda_worker, 'progress', lambda **kw: None)
    monkeypatch.setattr(settings, 'oanda_acquisition_mode', 'stream')
    stop = Stop(3)
    oanda_worker.run(SimpleNamespace(account_id='account', catalog=lambda: []), stop)
    assert len(claims) <= 1
    assert all(delay >= 5 for delay in stop.delays)


def test_new_bootstrap_keeps_legacy_records_disabled_and_preserves_saved_choice():
    from alerts import storage
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    engine = create_engine('sqlite://')
    try:
        storage.bootstrap(engine)
        with Session(engine) as db, db.begin():
            rows = [db.get(Instrument, key) for key in ('EURUSD', 'XAUUSD', 'BTCUSDT')]
            assert all(row is not None and not row.enabled for row in rows)
            rows[0].enabled = True
        storage.bootstrap(engine)
        with Session(engine) as db:
            assert db.get(Instrument, 'EURUSD').enabled
    finally:
        engine.dispose()


def test_replayed_batch_only_aggregates_changed_price_minutes(database, monkeypatch):
    from alerts import market
    from alerts.storage import Bar, instant
    rows = [dict(timestamp=i * 60000, open=10, high=12, low=9, close=11) for i in range(120)]
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': rows}, received_at=7300000)
    touched = []
    original = market.aggregate_touched
    def aggregate(db, instrument, minutes, **kwargs):
        if kwargs.get('kind', 'price') == 'price':
            touched.extend(minutes)
        return original(db, instrument, minutes, **kwargs)
    monkeypatch.setattr(market, 'aggregate_touched', aggregate)
    rows[-1] = {**rows[-1], 'close': 10}
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': rows}, received_at=7310000)
        bars = list(db.scalars(select(Bar).where(Bar.instrument_id == 'BTCUSDT', Bar.timeframe == 'M1')))
        assert len(bars) == 120
        assert all(bar.observed_at == 7310000 for bar in bars)
    assert set(touched) == {instant(119 * 60000)}


def test_cached_pricing_catalog_preserves_auth_probe_without_demand(monkeypatch):
    from types import SimpleNamespace
    probes = []
    monkeypatch.setattr(oanda_worker, 'claim', lambda *a, **kw: ('account', 'token'))
    monkeypatch.setattr(oanda_worker, 'ensure_catalog', lambda *a, **kw: None)
    monkeypatch.setattr(oanda_worker, 'desired_for_mode', lambda *a: {})
    monkeypatch.setattr(oanda_worker, 'closed_delay', lambda *a: None)
    monkeypatch.setattr(oanda_worker, 'park_closed', lambda *a: None)
    monkeypatch.setattr(oanda_worker, 'progress', lambda **kw: None)
    monkeypatch.setattr(oanda_worker, 'claim_auth_probe', lambda *a, **kw: ('account', 'probe'))
    def probe(*args):
        probes.append(True)
        return []
    monkeypatch.setattr(oanda_worker, 'probe_authentication', probe)
    monkeypatch.setattr(settings, 'oanda_acquisition_mode', 'stream')
    oanda_worker.run(SimpleNamespace(account_id='account', catalog=lambda: []), Stop(2))
    assert len(probes) == 2


def test_idle_pricing_keeps_not_due_auth_hold_visible(database, monkeypatch):
    from types import SimpleNamespace

    from alerts.storage import PricingOwner
    states = []
    key = live_pricing.account_key('account')
    with database.begin() as db:
        db.add(PricingOwner(id=key, error='unauthorized', next_at=10**15))
    monkeypatch.setattr(oanda_worker, 'claim', lambda *a, **kw: ('account', 'token'))
    monkeypatch.setattr(oanda_worker, 'ensure_catalog', lambda *a, **kw: None)
    monkeypatch.setattr(oanda_worker, 'desired_for_mode', lambda *a: {})
    monkeypatch.setattr(oanda_worker, 'closed_delay', lambda *a: None)
    monkeypatch.setattr(oanda_worker, 'park_closed', lambda *a: None)
    monkeypatch.setattr(oanda_worker, 'progress', lambda **kw: states.append(kw['state']))
    monkeypatch.setattr(settings, 'oanda_acquisition_mode', 'stream')
    oanda_worker.run(SimpleNamespace(account_id='account', catalog=lambda: []), Stop(2))
    assert states == ['idle', 'waiting_input', 'waiting_input']
    with database() as db:
        assert db.get(PricingOwner, key).next_at == 10**15


def test_provider_idle_sources_back_off_but_active_live_keeps_cadence(database, monkeypatch):
    from alerts import provider_service, publication_wakeup, runtime_health
    from test_idle_worker_costs import Wake
    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', lambda **kw: Wake())
    monkeypatch.setattr(runtime_health, 'progress', lambda **kw: None)
    idle = Stop(2)
    provider_service.run_live(idle, 'binance')
    assert idle.delays == [30, 30]
    monkeypatch.setattr(provider_service, 'realtime_step', lambda source: True)
    active = Stop(2)
    provider_service.run_live(active, 'binance')
    assert active.delays == [1, 1]
    monkeypatch.setattr(provider_service, 'warm_step', lambda *a, **kw: (None, False))
    warm = Stop(2)
    provider_service.run_warm(warm, 'binance')
    assert warm.delays == [30, 30]


def test_provider_not_due_subscription_is_active_only_for_its_source(database, monkeypatch):
    from alerts import provider_service as service
    from alerts.storage import ProviderInterest
    from test_provider_service import subscribed
    subscribed(monkeypatch, 'browser', 'chart', 0)
    with database.begin() as db:
        db.scalar(select(ProviderInterest)).next_poll = 10**15
    assert service.realtime_step('oanda') is True
    assert service.realtime_step('binance') is False


def test_provider_warm_not_due_backlog_keeps_one_second_service(database, monkeypatch):
    from alerts import provider_service as service
    from alerts import publication_wakeup, runtime_health
    from alerts.storage import ProviderInterest
    from test_idle_worker_costs import Wake
    from test_provider_cache import META, page, seed
    key = seed(META, 'M5', 100000, page(90000, 100000))
    service.activate('history', key, 100000, 10)
    with database.begin() as db:
        row = db.scalar(select(ProviderInterest))
        row.targets = [{**target, 'next_at': 10**15} for target in row.targets]
    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', lambda **kw: Wake())
    monkeypatch.setattr(runtime_health, 'progress', lambda **kw: None)
    stop = Stop(2)
    service.run_warm(stop, 'oanda')
    assert stop.delays == [1, 1]
