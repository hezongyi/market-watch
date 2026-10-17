"""Provider snapshots retain fixed origins while sharing incremental calculation work."""

import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts.chart_api import DataQuery
from alerts.chart_calculation_history import calculation_rows
from alerts.chart_indicators import calculate
from sqlalchemy import event
from test_provider_cache import META, page, seed

SPEC = {"name": "SUPERTREND_PINE_V1", "params": {"period": 10}}


def stable_indicators(page):
    """Execution counters vary with cache hits; numerical/input evidence must not."""
    return [{**item, "calculation": {key: value for key, value in item["calculation"].items()
                                    if key != "execution"}} for item in page["indicators"]]


def query(before=1000000, **kwargs):
    return DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1",
                     before=before, limit=200, indicators=[SPEC], **kwargs)


def test_repeated_and_appended_indicator_reads_do_not_reload_whole_prefix(database, monkeypatch):
    monkeypatch.setattr(upstream, "metadata", lambda _: META)
    key = seed(META, "M1", 1000000, page(1000, 1000000, boundary=True))
    statements = []
    engine = database.kw["bind"]

    def observe(conn, cursor, statement, params, context, many):
        if "provider_bars.payload" in statement and "ORDER BY provider_bars.start" in statement:
            statements.append((statement, params))

    event.listen(engine, "before_cursor_execute", observe)
    try:
        first = cache.data(query())
        repeated = cache.data(query())
        assert first["bars"] == repeated["bars"]
        assert stable_indicators(first) == stable_indicators(repeated)
        assert first['indicators'][0]['calculation']['execution']['input_cache'] == 'miss'
        assert repeated['indicators'][0]['calculation']['execution']['input_cache'] == 'hit'
        assert repeated['indicators'][0]['calculation']['execution']['calculation_steps'] == 0
        assert len(statements) == 1, "same input revision must reuse its frozen prefix"
        seed(META, "M1", 1001000, page(999000, 1001000))
        appended = cache.data(query(1001000))
        assert len(statements) == 2
        assert 999000 in statements[-1][1], "append must start at the retained mutable tail"
        with database.begin() as db:
            inputs = list(db.scalars(cache.select(cache.ProviderBar.payload).where(
                cache.ProviderBar.dataset_id == key).order_by(cache.ProviderBar.start)))
        expected = calculate(calculation_rows(inputs, META, META["id"]), SPEC)
        assert appended["indicators"][0]["series"] == [
            {**series, "values": [v for v in series["values"]
                                  if v["time"] >= appended["bars"][0]["start"]]}
            for series in expected["series"]]
    finally:
        event.remove(engine, "before_cursor_execute", observe)


@pytest.mark.parametrize("change", ["correction", "backfill", "forming"])
def test_revision_and_preview_cannot_reuse_an_obsolete_checkpoint(database, monkeypatch, change):
    monkeypatch.setattr(upstream, "metadata", lambda _: META)
    seed(META, "M1", 1000000, page(1000, 1000000, boundary=True))
    cache.data(query())
    payload = (page(300000, 301000, close="2.7") if change == "correction" else
               page(0, 1000) if change == "backfill" else
               page(1000000, 1001000, close="2.6", complete=False))
    seed(META, "M1", payload["bars"][-1]["end"], payload)
    before = 1001000 if change == "forming" else 1000000
    first = cache.data(query(before))
    if change == "forming":
        seed(META, "M1", before, page(1000000, before, close="1.2", complete=False))
        second = cache.data(query(before))
        assert first["indicators"] != second["indicators"]
    else:
        second = first
    key = cache.identity(META, "M1")
    with database.begin() as db:
        rows = list(db.scalars(cache.select(cache.ProviderBar.payload).where(
            cache.ProviderBar.dataset_id == key).order_by(cache.ProviderBar.start)))
    expected = calculate(calculation_rows(rows, META, META["id"]), SPEC, provisional=True)
    actual = second["indicators"][0]
    for series, reference in zip(actual["series"], expected["series"]):
        assert series["values"] == [v for v in reference["values"]
                                    if v["time"] >= second["bars"][0]["start"]]


@pytest.mark.parametrize('name', ['SMA', 'EMA', 'LWMA', 'BBANDS', 'RSI', 'MACD', 'ATR', 'STOCH',
                                  'SUPERTREND_PINE_V1'])
def test_all_checkpoint_engines_match_batch_across_window_changes(name):
    import math

    from alerts.provider_indicator_inputs import Inputs, compute

    rows = []
    for i in range(2400):
        close = 10 + math.sin(i / 13) + i / 10000
        rows.append({'start': i * 60000, 'end': (i + 1) * 60000, 'complete': True,
                     'open': str(close - .01), 'high': str(close + .1),
                     'low': str(close - .2), 'close': str(close),
                     **({'gap_before': True} if i == 700 else {})})
    rows[-1] = {**rows[-1], 'complete': False}
    spec = {'name': name, 'params': {}}
    for size, revision in [(1200, 1), (2400, 2), (1600, 1), (2400, 2)]:
        for preview in (False, True):
            inputs = Inputs(rows[:size], ('differential', name), 'epoch', revision)
            actual = compute(inputs, META, META['id'], spec, first=rows[size-100]['start'],
                             provisional=preview)
            expected = calculate(calculation_rows(rows[:size], META, META['id']), spec,
                                 provisional=preview)
            for series, reference in zip(actual['series'], expected['series'], strict=True):
                reference = [v for v in reference['values'] if v['time'] >= rows[size-100]['start']]
                assert len(series['values']) == len(reference)
                for value, target in zip(series['values'], reference, strict=True):
                    assert value.keys() == target.keys()
                    assert {k: v for k, v in value.items() if k != 'value'} == {
                        k: v for k, v in target.items() if k != 'value'}
                    assert value['value'] == pytest.approx(target['value'], rel=1e-10, abs=1e-10)


def test_cache_pressure_releases_oversized_entries(database, monkeypatch):
    from alerts import provider_indicator_inputs as engine
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(engine, 'MAX_ROWS', 10)
    monkeypatch.setattr(engine, 'MAX_VALUES', 10)
    seed(META, 'M1', 1000000, page(1000, 1000000, boundary=True))
    cache.data(query())
    assert sum(entry.weight for entry in engine._INPUTS.values()) <= 10
    assert sum(entry.weight for entry in engine._RESULTS.values()) <= 10


def test_restored_legacy_dataset_shares_exact_revision_without_epoch(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = seed(META, 'M1', 1000000, page(1000, 1000000, boundary=True))
    with database.begin() as db:
        dataset = db.get(cache.ProviderDataset, key)
        metadata = dict(dataset.metadata_json)
        metadata.pop('indicator_history_epoch')
        dataset.metadata_json = metadata
    statements = []
    pg = database.kw['bind']
    def observe(conn, cursor, statement, params, context, many):
        if ('provider_bars.payload' in statement and 'ORDER BY provider_bars.start' in statement
                and 'DESC' not in statement):
            statements.append(statement)
    event.listen(pg, 'before_cursor_execute', observe)
    try:
        first, second = cache.data(query()), cache.data(query())
        assert stable_indicators(first) == stable_indicators(second)
        assert len(statements) == 1, 'restored pre-patch data must share an unchanged input revision'
    finally:
        event.remove(pg, 'before_cursor_execute', observe)


def test_cancelled_waiter_does_not_abort_a_shared_calculation(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from alerts import provider_indicator_inputs as engine

    rows = page(0, 1000000)['bars']
    frozen = engine.Inputs(rows, ('shared-cancel',), 'epoch', 1)
    entered, release = threading.Event(), threading.Event()
    original = engine.IndicatorState.step
    def step(self, row, **kwargs):
        if not entered.is_set():
            entered.set()
            assert release.wait(3)
        return original(self, row, **kwargs)
    monkeypatch.setattr(engine.IndicatorState, 'step', step)
    def run():
        return engine.compute(frozen, META, META['id'], SPEC, first=0, provisional=True)
    with ThreadPoolExecutor(max_workers=1) as pool:
        active = pool.submit(run)
        assert entered.wait(3)
        cancelled = threading.Event()
        cancelled.set()
        token = cache.CANCELLED.set(cancelled)
        try:
            with pytest.raises(TimeoutError, match='取消'):
                run()
        finally:
            cache.CANCELLED.reset(token)
            release.set()
        result = active.result(timeout=3)
    assert any(v['value'] is not None for s in result['series'] for v in s['values'])
    assert run()['series'] == result['series']


def test_historical_window_reuses_prefix_while_live_tail_advances(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = seed(META, 'M1', 1000000, page(1000, 1000000, boundary=True))
    cache.data(query())
    statements = []
    engine = database.kw['bind']

    def observe(conn, cursor, statement, params, context, many):
        if ('provider_bars.payload' in statement and 'ORDER BY provider_bars.start' in statement
                and 'DESC' not in statement):
            statements.append((statement, params))

    event.listen(engine, 'before_cursor_execute', observe)
    try:
        for i in range(3):
            # The live writer changes only a tail strictly after this older
            # window. Its stable history epoch proves the retained prefix.
            seed(META, 'M1', 1001000 + i * 1000,
                 page(999000 + i * 1000, 1001000 + i * 1000))
            result = cache.data(query(800000))
            with database.begin() as db:
                rows = list(db.scalars(cache.select(cache.ProviderBar.payload).where(
                    cache.ProviderBar.dataset_id == key, cache.ProviderBar.start < 800000)
                    .order_by(cache.ProviderBar.start)))
            expected = calculate(calculation_rows(rows, META, META['id']), SPEC)
            assert result['indicators'][0]['series'] == [
                {**series, 'values': [v for v in series['values']
                                     if v['time'] >= result['bars'][0]['start']]}
                for series in expected['series']]
        # Each independent batch reference above issues one prefix query.
        assert len(statements) == 3, 'live append must not reload an unchanged historical prefix'
    finally:
        event.remove(engine, 'before_cursor_execute', observe)
