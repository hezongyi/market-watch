"""Cross-process priority, consumer fencing and maintenance budgets."""

import pytest
from alerts import fixed_indicators as jobs
from alerts import indicator_demands as demands
from alerts.chart_api import DataQuery, data_sync
from alerts.storage import FixedIndicatorRun, IndicatorDemand, IndicatorSchedule
from sqlalchemy import select
from test_fixed_indicators import history


def setup_runs(database, monkeypatch):
    version = history(database, monkeypatch, count=2107)
    runs = []
    for period in (19, 20):
        result = data_sync(
            DataQuery(
                instrument=version,
                series_kind="history",
                timeframe="M1",
                limit=7,
                indicators=[{"name": "EMA", "params": {"period": period}}],
            )
        )
        runs.append(result["indicator_progress"][0]["run_id"])
    return runs


def consumer(ident="pane-1", generation=1, period=19, purpose="foreground"):
    return dict(
        id=ident,
        generation=generation,
        spec={"name": "EMA", "params": {"period": period}},
        purpose=purpose,
    )


def renew(database, run_id, consumers, stamp):
    with database.begin() as db:
        demands.renew(
            db,
            "page",
            consumers,
            db.get(FixedIndicatorRun, run_id),
            snapshot_id=None,
            start=100,
            end=200,
            stamp=stamp,
        )


def test_shared_cancellation_late_http_and_late_release_are_fenced(database, monkeypatch):
    run, _ = setup_runs(database, monkeypatch)
    renew(database, run, [consumer(), consumer("pane-2")], 100)
    with database.begin() as db:
        demands.release(db, "page", [{"id": "pane-1", "generation": 1}], stamp=200)
    renew(database, run, [consumer()], 300)  # HTTP response after cancellation
    with database.begin() as db:
        rows = list(db.scalars(select(IndicatorDemand).order_by(IndicatorDemand.consumer)))
        assert rows[0].released and not rows[1].released
    renew(database, run, [consumer(generation=2)], 400)
    with database.begin() as db:
        demands.release(db, "page", [{"id": "pane-1", "generation": 1}], stamp=500)
    with database.begin() as db:
        first = db.scalar(select(IndicatorDemand).where(IndicatorDemand.consumer == "pane-1"))
        assert not first.released and first.generation == 2
        assert first.expires == 400 + demands.TTL_MS


def test_cancel_before_http_commit_leaves_a_bounded_tombstone(database, monkeypatch):
    run, _ = setup_runs(database, monkeypatch)
    with database.begin() as db:
        demands.release(db, "page", [{"id": "pane-1", "generation": 1}], stamp=100)
    renew(database, run, [consumer()], 200)
    with database.begin() as db:
        row = db.scalar(select(IndicatorDemand))
        assert row.released and row.run_id is None and row.expires == 60100


def test_one_quarter_maintenance_and_expiry_observed_by_claim(database, monkeypatch):
    foreground, maintenance = setup_runs(database, monkeypatch)
    monkeypatch.setattr(jobs, "now_ms", lambda: 1000)
    renew(database, foreground, [consumer()], 1000)
    claimed = []
    for _ in range(4):
        owner = jobs.claim()
        claimed.append(owner["id"])
        with database.begin() as db:
            db.get(FixedIndicatorRun, owner["id"]).lease_until = 0
    assert claimed == [foreground] * 3 + [maintenance]
    with database.begin() as db:
        db.get(IndicatorSchedule, "fixed").turn = 0
        db.get(FixedIndicatorRun, maintenance).updated_at = 0
    monkeypatch.setattr(jobs, "now_ms", lambda: 1000 + demands.TTL_MS + 1)
    assert jobs.claim()["id"] == maintenance, "expired foreground has no surviving priority"


def test_capacity_is_bounded_and_same_consumer_edit_replaces_demand(database, monkeypatch):
    first, second = setup_runs(database, monkeypatch)
    monkeypatch.setattr(demands, "MAX_CLIENT_DEMANDS", 1)
    renew(database, first, [consumer()], 100)
    renew(database, second, [consumer(period=20, generation=2)], 200)
    with database.begin() as db:
        rows = list(db.scalars(select(IndicatorDemand)))
        assert len(rows) == 1 and rows[0].run_id == second
    with pytest.raises(demands.DemandCapacity):
        renew(database, first, [consumer("pane-2")], 300)


def test_warmup_has_service_share_and_a_single_concurrent_claim(database, monkeypatch):
    first, second = setup_runs(database, monkeypatch)
    monkeypatch.setattr(jobs, "now_ms", lambda: 1000)
    renew(database, first, [consumer(purpose="warmup")], 1000)
    renew(database, second, [consumer("warm-2", period=20, purpose="warmup")], 1000)
    owner = jobs.claim()
    assert owner and jobs.claim() is None, "one warmup claim per role even across worker sessions"
    with database.begin() as db:
        db.get(FixedIndicatorRun, owner["id"]).lease_until = 0
    assert jobs.claim() is not None
