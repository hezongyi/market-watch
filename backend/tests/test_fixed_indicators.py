"""Fixed artifact inputs, immutable repair, bounded progress and fencing."""

import copy

import pytest
from alerts import fixed_indicators as jobs
from alerts.chart_api import DataQuery, data_sync
from alerts.chart_indicators import calculate
from alerts.composite_chart import chart_page
from alerts.composite_inputs import apply_minutes
from alerts.confirmed_minutes import record
from alerts.history_artifacts import artifact_tick, read_artifact
from alerts.history_versions import create_version, import_page
from alerts.market_contracts import DatasetIdentity
from alerts.storage import (
    CompositeRevision,
    FixedIndicatorBlock,
    FixedIndicatorRun,
    MarketDataset,
    RealtimeMapping,
)
from alerts.supertrend_pine import NAME as SUPERTREND_NAME
from sqlalchemy import select
from test_composite_aggregates import drain as aggregates
from test_composite_chart import populated
from test_composite_definitions import prepare
from test_history_versions import Adapter
from test_indicator_state import prices
from test_market_contracts import batch, identity, minute

SPEC = {"id": "ema", "name": "EMA", "params": {"period": 19}}


def history(database, monkeypatch, count=2107):
    prepare(database, monkeypatch)
    with database.begin() as db:
        version = create_version(db, identity().key, 0, count * 60000)
    rows = tuple(minute(row["start"], open=f'{row["close"]:.5f}', high=f'{row["high"]:.5f}',
        low=f'{row["low"]:.5f}', close=f'{row["close"]:.5f}') for row in prices(count))
    import_page(Adapter([batch(window_end=count * 60000, checkpoint=count * 60000, rows=rows)]), version_id=version)
    while artifact_tick(version):
        pass
    return version


def drain(ident):
    for _ in range(100):
        if not jobs.indicator_tick(ident):
            return
    raise AssertionError("indicator job failed to finish")


def test_historical_page_reads_full_origin_and_persisted_outputs_without_m1(database, monkeypatch):
    version = history(database, monkeypatch)
    query = DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=7, indicators=[SPEC])
    pending = data_sync(query)
    ident = pending["indicator_progress"][0]["run_id"]
    assert pending["pending"] and pending["indicators"][0]["series"][0]["values"] == []
    drain(ident)
    with database.begin() as db:
        rows = read_artifact(db, version, "M1", limit=20000)
        expected = calculate(rows, SPEC)["series"][0]["values"][-7:]
        run = db.get(FixedIndicatorRun, ident)
        assert run.status == "complete" and run.state["state"]["origin"] == 0
        assert len(list(db.scalars(select(FixedIndicatorBlock)))) == 2
    def forbidden(*args, **kwargs):
        raise AssertionError("Persisted indicator reads cannot scan historical M1")
    monkeypatch.setattr("alerts.composite_series.snapshot_rows", forbidden)
    result = data_sync(query)
    assert not result["pending"]
    assert result["indicators"][0]["series"][0]["values"] == expected
    assert all(row["dependency_origin"] == 0 for row in result["indicators"][0]["dependencies"])
    older = data_sync(query.model_copy(update={"before": rows[-7]["start"]}))
    assert older["indicator_progress"][0]["run_id"] == ident


def test_bounded_progress_fences_stale_owners_and_recovers_from_checkpoint(database, monkeypatch):
    version = history(database, monkeypatch)
    page = data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=2, indicators=[SPEC]))
    ident = page["indicator_progress"][0]["run_id"]
    old = jobs.claim(ident)
    result = jobs.build(old)
    assert len(result["rows"]) == jobs.PAGE_SIZE and not result["done"]
    with database.begin() as db:
        db.get(FixedIndicatorRun, ident).lease_until = 0
    successor = jobs.claim(ident)
    with pytest.raises(TimeoutError):
        jobs.commit(old, result)
    jobs.commit(successor, jobs.build(successor))
    with pytest.raises(TimeoutError):
        jobs.commit(successor, result)
    drain(ident)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, ident)
        assert run.cursor == 2107 * 60000 and run.status == "complete"
    with pytest.raises(ValueError, match="immutable"):
      with database.begin() as db:
        block = db.scalar(select(FixedIndicatorBlock))
        block.checkpoint = {}
        db.flush()


def add_tail(database, revision_id, rows, *, observed_at=210000000):
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        apply_minutes(db, record(db, batch(identity=DatasetIdentity.model_validate(target.identity),
            window_start=min(row.timestamp for row in rows), window_end=max(row.timestamp for row in rows) + 60000,
            checkpoint=max(row.timestamp for row in rows) + 60000, observed_at=observed_at,
            volume_kind="price_count", volume_unit="quotes", rows=tuple(rows))))


@pytest.mark.parametrize("spec", [
    {"name": "EMA", "params": {"period": 2}},
    {"name": SUPERTREND_NAME, "params": {"period": 2, "multiplier": 0.1}},
])
def test_composite_append_reuses_prefix_correction_repairs_suffix_and_old_input_remains(database, monkeypatch, spec):
    monkeypatch.setattr(jobs, "PAGE_SIZE", 4)
    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, "M1")
    def request(value):
        with database.begin() as db:
            page = chart_page(db, composite, "M1", input_revision=value, now=200010000, count=20)
            run = jobs.request(db, page, spec, stamp=200010000)
            return run.id, copy.deepcopy(page)
    old, page = request(1)
    drain(old)
    with database.begin() as db:
        original = jobs.outputs(db, db.get(FixedIndicatorRun, old), 0, 200010000)
    add_tail(database, revision, [minute(seam + 600000, volume="3", close="1.115")])
    aggregates(revision, "M1")
    appended, _ = request(2)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, appended)
        assert run.parent_id == old and run.prefix_end > seam
    drain(appended)
    add_tail(database, revision, [minute(seam + 180000, volume="3", close="1.119")])
    aggregates(revision, "M1")
    repaired, corrected = request(3)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, repaired)
        assert run.parent_id == appended and run.prefix_end <= seam + 180000
    drain(repaired)
    with database.begin() as db:
        assert jobs.outputs(db, db.get(FixedIndicatorRun, old), 0, 200010000) == original
        actual = jobs.outputs(db, db.get(FixedIndicatorRun, repaired), 0, 200010000)
        _, _, phase, profiles = jobs._context(db, db.get(FixedIndicatorRun, repaired))
        previous = None
        for row in corrected["bars"]:
            row["gap_before"] = jobs.gap_before(previous, row["start"], phase, profiles)
            previous = row["end"]
        for series in calculate(corrected["bars"], spec)["series"]:
            expected = series["values"]
            assert [row["start"] for row in actual] == [row["time"] for row in expected]
            assert [row["values"][series["key"]] for row in actual] == pytest.approx([row["value"] for row in expected])


def test_missing_aggregate_waterline_waits_without_publishing_or_advancing(database, monkeypatch):
    composite, revision, _ = populated(database, monkeypatch)
    with database.begin() as db:
        page = chart_page(db, composite, "M1", now=200010000)
        run_id = jobs.request(db, page, SPEC, stamp=200010000).id
    owner = jobs.claim(run_id)
    assert jobs.build(owner) is None
    jobs.commit(owner, None)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, run_id)
        assert run.cursor == 0 and run.status == "pending"
        run.next_at = 0
        assert db.scalar(select(FixedIndicatorBlock)) is None
    aggregates(revision, "M1")
    drain(run_id)
    with database.begin() as db:
        assert db.get(FixedIndicatorRun, run_id).status == "complete"


def test_failed_build_preserves_cursor_and_retries(database, monkeypatch):
    version = history(database, monkeypatch, count=50)
    page = data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=2, indicators=[SPEC]))
    ident = page["indicator_progress"][0]["run_id"]
    original = jobs.build
    def broken(_):
        raise OSError("test failure")
    monkeypatch.setattr(jobs, "build", broken)
    assert jobs.indicator_tick(ident)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, ident)
        assert run.cursor == 0 and run.error == "OSError" and run.next_at > 0
        run.next_at = 0
    monkeypatch.setattr(jobs, "build", original)
    drain(ident)
    with database.begin() as db:
        assert db.get(FixedIndicatorRun, ident).error is None


def test_recursive_history_review_includes_dependencies_before_visible_price_range(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, "M1")
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", limit=3,
        indicators=[SPEC], track_history=True, revision_after=seam + 300000, provisional=False)
    initial = data_sync(query)
    ident = initial["indicator_progress"][0]["run_id"]
    drain(ident)
    ready = data_sync(query)
    assert ready["history_check"]["revision"] != initial["history_check"]["revision"]
    add_tail(database, revision, [minute(seam + 60000, volume="3", close="1.119")])
    corrected = data_sync(query)
    assert [[bar[key] for key in ("start", "end", "open", "high", "low", "close")] for bar in corrected["bars"]] == [
        [bar[key] for key in ("start", "end", "open", "high", "low", "close")] for bar in ready["bars"]]
    assert corrected["history_check"]["revision"] != ready["history_check"]["revision"]
    fixed = data_sync(query.model_copy(update={"input_revision": 1}))
    assert fixed["history_check"]["revision"] == ready["history_check"]["revision"]


def test_completed_indicator_cache_does_not_prevent_unreferenced_history_reclamation(database, monkeypatch):
    from alerts.history_retention import reclaim, references
    from alerts.storage import DatasetMaintenance

    version = history(database, monkeypatch, count=50)
    page = data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=2, indicators=[SPEC]))
    drain(page["indicator_progress"][0]["run_id"])
    with database.begin() as db:
        db.add(DatasetMaintenance(dataset_id=identity().key, target_start=0, timeframes=["M1"],
                                  next_at=0, paused=True, archived=True))
    with database.begin() as db:
        assert references(db, identity().key)["can_reclaim"]
        result = reclaim(db, identity().key, "reclaim-indicators")
        assert result["deleted"][FixedIndicatorRun.__tablename__] == 1
        assert result["deleted"][FixedIndicatorBlock.__tablename__] == 1


def test_indicator_csv_pending_commits_request_and_ready_exports_all_pages(database, monkeypatch):
    import csv
    import io

    from alerts import api
    from fastapi.testclient import TestClient

    version = history(database, monkeypatch, count=2107)
    body = {"instrument": version, "series_kind": "history", "timeframe": "M1", "start": 107 * 60000,
            "end": 2107 * 60000, "indicators": [SPEC]}
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            pending = client.post("/api/charts/export", json=body)
            assert pending.status_code == 409
            with database.begin() as db:
                ident = db.scalar(select(FixedIndicatorRun.id))
                assert ident
            drain(ident)
            response = client.post("/api/charts/export", json=body)
            assert response.status_code == 200, response.text
            rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
            assert len(rows) == 2000
            assert all(row["python:1:ema:value"] for row in rows)
    finally:
        api.app.dependency_overrides.clear()


def test_seam_inside_evidenced_closure_still_marks_recursive_cross_source_dependency(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    with database.begin() as db:
        page = chart_page(db, composite, "M1", now=200010000)
        ident = jobs.request(db, page, {"name": "EMA", "params": {"period": 2}}, stamp=200010000).id
    rows = prices(3)
    rows[-1].update(start=seam + 60000, end=seam + 120000)
    monkeypatch.setattr(jobs, "input_rows", lambda *_: (rows, "ny17", []))
    result = jobs.build(jobs.claim(ident))
    assert result["rows"][-1]["seam_dependency"] is True
    assert result["rows"][-1]["dependency_origin"] == 0


def test_provisional_chart_value_never_advances_durable_confirmed_state(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, "M1")
    spec = {"name": "EMA", "params": {"period": 2}}
    stamp = seam + 650000
    with database.begin() as db:
        page = chart_page(db, composite, "M1", now=stamp, count=20)
        ident = jobs.request(db, page, spec, stamp=stamp).id
    drain(ident)
    forming = {**page["bars"][-1], "start": seam + 600000, "end": seam + 660000,
        "close": "1.119", "source_confirmed": False, "complete": False, "coverage_complete": False}
    page["bars"].append(forming)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, ident)
        original = copy.deepcopy(run.state)
        blocks = list(db.scalars(select(FixedIndicatorBlock)))
        results, progress = jobs.chart_results(db, page, [spec], provisional=True, stamp=stamp)
        assert progress[0]["run_id"] == ident and progress[0]["status"] == "complete"
        value = results[0]["series"][0]["values"][-1]
        assert value["provisional"] and value["value"] is not None
        assert run.state == original
        assert list(db.scalars(select(FixedIndicatorBlock))) == blocks
        second, _ = jobs.chart_results(db, page, [spec], provisional=False, stamp=stamp)
        assert all(row["time"] < forming["start"] for row in second[0]["series"][0]["values"])


@pytest.mark.parametrize('name', ['EMA', SUPERTREND_NAME])
@pytest.mark.parametrize('later_confirmed', [False, True])
def test_observed_suffix_replays_all_recursive_dependencies(database, monkeypatch, name, later_confirmed):
    composite, revision, seam = populated(database, monkeypatch)
    if later_confirmed:
        add_tail(database, revision, [minute(seam + 720000, close='1.114', volume='3')])
    aggregates(revision, 'M1')
    spec = {'name': name, 'params': {'period': 2}}
    stamp = seam + 850000
    with database.begin() as db:
        page = chart_page(db, composite, 'M1', now=stamp, count=20)
        ident = jobs.request(db, page, spec, stamp=stamp).id
    drain(ident)
    pending = [{**page['bars'][-1], 'start': seam + i * 60000, 'end': seam + (i + 1) * 60000,
        'close': str(1.111 + n * .001), 'complete': False, 'source_confirmed': False,
        'coverage_complete': False, 'volume': None}
        for n, i in enumerate([10, 11] if later_confirmed else [10, 11, 12])]
    page['bars'] = sorted([*page['bars'], *pending], key=lambda bar: bar['start'])
    reference = calculate([{**bar, 'complete': True} for bar in page['bars']], spec)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, ident)
        original = copy.deepcopy(run.state)
        actual, _ = jobs.chart_results(db, page, [spec], provisional=True, stamp=stamp)
        assert run.state == original
    for series in reference['series']:
        wanted = [(point['time'], point['value']) for point in series['values'] if point['time'] >= pending[0]['start']]
        found = next(item for item in actual[0]['series'] if item['key'] == series['key'])['values']
        found = [(point['time'], point['value']) for point in found if point['time'] >= pending[0]['start']]
        assert [at for at, _ in found] == [at for at, _ in wanted]
        assert [value for _, value in found] == pytest.approx([value for _, value in wanted], abs=1e-10)
    suffix = [row for row in actual[0]['dependencies'] if row['start'] >= pending[0]['start']]
    assert all(row['provisional'] for row in suffix)


def test_worker_never_reinterprets_pending_state_from_an_older_algorithm(database, monkeypatch):
    version = history(database, monkeypatch, count=40)
    page = data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", indicators=[SPEC]))
    ident = page["indicator_progress"][0]["run_id"]
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, ident)
        values = {column.key: copy.deepcopy(getattr(run, column.key)) for column in FixedIndicatorRun.__table__.columns}
        values.update(id="f" * 64, group_key="e" * 64, algorithm="fixed-indicator-state-v0")
        values["state"]["algorithm"] = "fixed-indicator-state-v0"
        db.add(FixedIndicatorRun(**values))
    assert jobs.claim("f" * 64) is None
    assert jobs.claim(ident) is not None
