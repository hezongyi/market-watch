from datetime import UTC, datetime

import pytest
from alerts import api as api_module
from alerts import market
from alerts.chart_history_plan import advance_plan, control_plan, update_demand
from alerts.managed_dataset import date_start, join, publish_frame, read_rows, status
from alerts.storage import (
    ChartHistoryPlan,
    ChartPublication,
    ImportJob,
    Instrument,
    ms,
)
from fastapi.testclient import TestClient
from sqlalchemy import func, select

START = ms(datetime(2026, 9, 28, tzinfo=UTC))
MINUTE = 60000


def payload(left, minutes, price=10):
    return dict(
        source="binance",
        basis="last",
        rows=[
            dict(
                timestamp=left + i * MINUTE, open=price, high=price + 1, low=price - 1, close=price
            )
            for i in range(minutes)
        ],
        coverage=[dict(start=left, end=left + minutes * MINUTE)],
    )


def test_join_is_persistent_and_date_uses_trading_session(database):
    now = START + 30 * MINUTE + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        inst.enabled = False
        plan = join(db, inst, START, now)
        assert inst.enabled and plan.realtime_enabled and plan.target_end == now - 5000
        assert plan.cursor == plan.target_end
        # Later display/indicator demands may not grant earlier history.
        for frame in ("M1", "M5", "W1", "MN"):
            update_demand(
                db,
                ident=frame,
                instrument=inst.id,
                timeframe=frame,
                end=now + 86400000,
                visible=2000,
                required=6000,
                focused=True,
                now=now,
            )
        assert plan.target_start == START and plan.target_end == now - 5000
        join(db, inst, START + MINUTE, now + 86400000)
        assert plan.target_start == START and plan.target_end == now - 5000
        gold = db.get(Instrument, "XAUUSD")
        assert date_start(gold, "2026-03-09") == ms(datetime(2026, 3, 8, 21, tzinfo=UTC))
        assert date_start(gold, "2026-11-02") == ms(datetime(2026, 11, 1, 22, tzinfo=UTC))


def test_publication_turn_is_bounded_and_rotates_across_all_periods_and_symbols(database, monkeypatch):
    from alerts import managed_dataset as managed

    with database.begin() as db:
        for ident in ("BTCUSDT", "EURUSD"):
            join(db, db.get(Instrument, ident), START, START + 30 * MINUTE + 5000)
    calls = []
    monkeypatch.setattr(managed, "_PUBLISH_CURSOR", None, raising=False)
    monkeypatch.setattr(managed, "publish_frame", lambda db, inst, plan, frame, now:
                        calls.append((inst.id, frame)))
    managed.publish_once()
    assert len(calls) == 1, "one worker aggregation slice must not wait for every publication"
    for _ in range(2 * len(managed.FRAMES) - 1):
        managed.publish_once()
    assert len(calls) == 2 * len(managed.FRAMES)
    assert set(calls) == {(ident, frame) for ident in ("BTCUSDT", "EURUSD")
                          for frame in managed.FRAMES}
    managed.publish_once()
    assert calls[-1] == calls[0], "completed rotation starts another pass for realtime changes"


def test_viewing_unmaintained_never_creates_plan_or_task(database):
    with database.begin() as db:
        assert (
            update_demand(
                db,
                ident="pane",
                instrument="BTCUSDT",
                timeframe="MN",
                end=START,
                visible=1000,
                focused=True,
                now=START,
            )
            is None
        )
        assert db.scalar(select(func.count()).select_from(ChartHistoryPlan)) == 0
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_scheduler_backwards_bounded_yields_and_does_not_skip_newer_failure(database):
    now = START + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START - 86400000, now)
        assert advance_plan(db, plan, now)
        job = db.scalar(select(ImportJob))
        assert (job.start, job.end, job.priority) == (START - 600 * MINUTE, START, 300)
        assert not advance_plan(db, plan, now)
        job.status = "failed"
        assert not advance_plan(db, plan, now)
        control_plan(db, inst.id, "retry", now)
        assert job.status == "superseded"
        assert advance_plan(db, plan, now)
        assert plan.target_start == START - 86400000


def test_cancel_only_history_and_resume_only_missing_coverage(database):
    end = START + 30 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START, now)
        market.ingest(db, inst, payload(START + 10 * MINUTE, 20), received_at=now)
        for frame in ("M1", "M5"):
            publish_frame(db, inst, plan, frame, now)
        assert advance_plan(db, plan, now)
        job = db.scalar(select(ImportJob))
        assert job.end == START + 10 * MINUTE
        published = read_rows(db, inst, "M5", end, 100)
        control_plan(db, inst.id, "cancel", now)
        assert inst.enabled and plan.realtime_enabled and plan.status == "cancelled"
        assert read_rows(db, inst, "M5", end, 100) == published
        assert not advance_plan(db, plan, now)
        control_plan(db, inst.id, "resume", now)
        assert advance_plan(db, plan, now)
        active = db.scalar(select(ImportJob).where(ImportJob.status == "pending"))
        assert active.end == START + 10 * MINUTE


def test_completed_short_target_opens_real_bars_and_no_truncated_high_period(database):
    end = START + 30 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START, now)
        market.ingest(db, inst, payload(START, 30), received_at=now)
        publish_frame(db, inst, plan, "M5", now)
        state = status(db, inst, "M5", width=960, spacing=6)
        assert state["threshold"] == 480 and state["complete_count"] == 6
        assert state["initialized"] and state["ready"]
        assert len(read_rows(db, inst, "M5", end, 100)) == 6
        # No complete monthly candle, no fake candle before the approved start.
        publish_frame(db, inst, plan, "MN", now)
        month = status(db, inst, "MN")
        assert month["complete_count"] == 0 and not month["ready"]
        assert month["initialized"] and month["reason"] == "no_complete_bars"
        assert read_rows(db, inst, "MN", end, 100) == []
        indicator = status(db, inst, "M5", width=12, spacing=6, lookback=20)
        assert not indicator["ready"] and not indicator["indicator_ready"]
        assert plan.target_start == START


def test_period_opens_before_full_target_when_three_screens_complete(database):
    end = START + 2400 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START - 30 * 86400000, now)
        market.ingest(db, inst, payload(START, 2400), received_at=now)
        publish_frame(db, inst, plan, "M5", now)
        publish_frame(db, inst, plan, "H4", now)
        m5 = status(db, inst, "M5", width=960, spacing=6)
        assert m5["ready"] and m5["complete_count"] == 480 and not m5["initialized"]
        assert not status(db, inst, "H4", width=960, spacing=6)["ready"]
        assert plan.status == "pending" and plan.target_start == START - 30 * 86400000
        # Repeated publication is idempotent; no revisions for identical snapshots.
        revision = db.get(ChartPublication, (inst.id, "M5")).revision
        publish_frame(db, inst, plan, "M5", now)
        assert db.get(ChartPublication, (inst.id, "M5")).revision == revision


def test_staging_revision_does_not_replace_published_candles_until_aggregation(database):
    from alerts.chart_aggregation import aggregate_once

    end = START + 10 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START, now)
        market.ingest(db, inst, payload(START, 10), received_at=now)
        publish_frame(db, inst, plan, "M5", now)
        original = read_rows(db, inst, "M5", end, 100)
        market.ingest(db, inst, payload(START, 10, 20), received_at=now, defer_aggregation=True)
        publish_frame(db, inst, plan, "M5", now)
        assert read_rows(db, inst, "M5", end, 100) == original
    for _ in range(5):
        assert aggregate_once()
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = db.get(ChartHistoryPlan, inst.id)
        publish_frame(db, inst, plan, "M5", now)
        assert float(read_rows(db, inst, "M5", end, 100)[0]["close"]) == 20


def test_session_boundary_freezes_historical_expansion_but_latest_advances(database):
    end = START + 20 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START - 20 * MINUTE, now)
        market.ingest(db, inst, payload(START, 20), received_at=now)
        publish_frame(db, inst, plan, "M5", now)
        session_left = db.get(ChartPublication, (inst.id, "M5")).start
        market.ingest(db, inst, payload(START - 20 * MINUTE, 20), received_at=now)
        market.ingest(db, inst, payload(end, 5), received_at=now + 5 * MINUTE)
        publish_frame(db, inst, plan, "M5", now + 5 * MINUTE)
        frozen = read_rows(db, inst, "M5", end + 5 * MINUTE, 100, dataset_start=session_left)
        refreshed = read_rows(db, inst, "M5", end + 5 * MINUTE, 100)
        assert frozen[0]["start"] == session_left and len(refreshed) > len(frozen)
        assert frozen[-1]["end"] == end + 5 * MINUTE
        assert plan.target_end == end


def test_forming_bar_requires_complete_prefix_and_never_counts_towards_opening(database):
    end = START + 12 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START, now)
        market.ingest(db, inst, payload(START, 12), received_at=now)
        publish_frame(db, inst, plan, "M5", now)
        rows = read_rows(db, inst, "M5", end + 5 * MINUTE, 100)
        assert len(rows) == 3 and rows[-1]["complete"] is False
        assert rows[-1]["start"] == START + 10 * MINUTE
        state = status(db, inst, "M5", width=960, spacing=6)
        assert state["initialized"] and state["complete_count"] == 2 and state["ready"]
        # A later observation extends the same forming bucket, never duplicates it.
        market.ingest(db, inst, payload(end, 1, 20), received_at=now + MINUTE)
        publish_frame(db, inst, plan, "M5", now + MINUTE)
        updated = read_rows(db, inst, "M5", end + 5 * MINUTE, 100)
        assert len(updated) == 3 and float(updated[-1]["close"]) == 20
        assert status(db, inst, "M5")["complete_count"] == 2


def test_publication_transaction_failure_preserves_visible_rows_and_revision(database):
    end = START + 10 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START, now)
        market.ingest(db, inst, payload(START, 10), received_at=now)
        publish_frame(db, inst, plan, "M5", now)
        before = read_rows(db, inst, "M5", end, 100)
        revision = db.get(ChartPublication, (inst.id, "M5")).revision
    with pytest.raises(RuntimeError, match="interrupted publication"):
        with database.begin() as db:
            inst = db.get(Instrument, "BTCUSDT")
            plan = db.get(ChartHistoryPlan, inst.id)
            market.ingest(db, inst, payload(START, 10, 20), received_at=now)
            publish_frame(db, inst, plan, "M5", now)
            db.flush()
            raise RuntimeError("interrupted publication")
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        assert read_rows(db, inst, "M5", end, 100) == before
        assert db.get(ChartPublication, (inst.id, "M5")).revision == revision


def test_recent_repairs_ignore_historical_reservation_and_split_old_gap(database):
    now = START + 3 * 86400000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        history = ImportJob(instrument_id=inst.id, start=START, end=now, cursor=START, priority=300)
        db.add(history)
        db.flush()
        market.enqueue_repair(db, inst, START, now, recent_end=now)
        jobs = list(db.scalars(select(ImportJob)))
        assert history.priority == 300
        recent = [j for j in jobs if j.priority == 0]
        assert recent and all(
            j.start >= now - 86400000 and j.end - j.start <= 120 * MINUTE for j in recent
        )
        old = [j for j in jobs if j.priority == 50]
        assert old and all(j.end <= now - 86400000 for j in old)
        assert not market.import_once(
            history_only=True, fetcher=lambda *a: pytest.fail("history should yield")
        )


def test_api_start_only_maintenance_and_published_read_does_not_download(database, monkeypatch):
    from alerts import provider_chart

    monkeypatch.setattr(provider_chart, "earliest_m1", lambda meta: 0)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post(
                "/api/market-data/dataset", json={"instrument": "BTCUSDT", "timeframe": "M5"}
            )
            assert response.status_code == 200 and response.json()["reason"] == "unmaintained"
            page = client.post(
                "/api/charts/data",
                json={"instrument": "BTCUSDT", "timeframe": "M5", "published": True},
            )
            assert page.status_code == 200 and page.json()["bars"] == []
            with database.begin() as db:
                assert db.scalar(select(func.count()).select_from(ImportJob)) == 0
            response = client.post(
                "/api/market-data/maintenance",
                json={"instrument": "BTCUSDT", "start_date": "2026-09-28"},
            )
            assert response.status_code == 200 and response.json()["realtime_enabled"]
            assert response.json()["start"] == START
    finally:
        api_module.app.dependency_overrides.clear()


def test_legacy_adoption_keeps_verified_data_and_never_authorizes_new_history(database):
    from alerts.managed_dataset import adopt_legacy_once

    now = START + 30 * MINUTE + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        inst.enabled = False
        market.ingest(db, inst, payload(START, 30), received_at=now)
    adopt_legacy_once()
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = db.get(ChartHistoryPlan, inst.id)
        assert plan and not plan.realtime_enabled and not inst.enabled
        assert plan.target_start == START and plan.target_end == now - 5000
        publish_frame(db, inst, plan, "M5", now)
        assert status(db, inst, "M5")["ready"]
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


@pytest.mark.parametrize("offset", [1, 1234, 59999])
def test_fractional_legacy_coverage_adopts_only_complete_minutes(database, offset):
    from alerts.managed_dataset import adopt_legacy_once
    from alerts.storage import MarketCoverage

    end = START + 30 * MINUTE
    now = end + MINUTE + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        inst.enabled = False
        market.ingest(db, inst, payload(START, 31), received_at=now)
        # Reproduce coverage written by the older wall-clock query path.
        coverage = db.scalar(select(MarketCoverage).where(MarketCoverage.instrument_id == inst.id))
        coverage.start, coverage.end = START + offset, end + offset
    adopt_legacy_once()
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = db.get(ChartHistoryPlan, inst.id)
        publish_frame(db, inst, plan, "M5", now)
        state = status(db, inst, "M5")
        assert state["initialized"] and state["ready"]
        assert (plan.target_start, plan.target_end, plan.cursor) == (
            START + MINUTE,
            end,
            START + MINUTE,
        )
        assert plan.status == "complete" and not plan.realtime_enabled
        assert state["complete_count"] == 5
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_legacy_adoption_skips_subminute_coverage_and_preserves_existing_approval(database):
    from alerts.managed_dataset import adopt_legacy_once
    from alerts.storage import MarketCoverage

    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        db.add(
            MarketCoverage(
                instrument_id=inst.id,
                source=inst.source,
                basis=inst.basis,
                start=START + 1,
                end=START + MINUTE,
            )
        )
    adopt_legacy_once()
    with database.begin() as db:
        assert db.get(ChartHistoryPlan, "BTCUSDT") is None
        inst = db.get(Instrument, "EURUSD")
        approved = join(db, inst, START - MINUTE, START + 30 * MINUTE + 5000)
        market.ingest(
            db,
            inst,
            {**payload(START, 30), "source": inst.source, "basis": inst.basis},
            received_at=START + 31 * MINUTE,
        )
        original = (approved.target_start, approved.target_end, approved.cursor)
    adopt_legacy_once()
    with database.begin() as db:
        plan = db.get(ChartHistoryPlan, "EURUSD")
        assert (plan.target_start, plan.target_end, plan.cursor) == original


def test_approved_start_in_empty_session_does_not_prevent_short_target_exception(database):
    now = START + 30 * MINUTE + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        plan = join(db, inst, START, now)
        # Legitimate sparse upstream observations after an empty first bucket.
        data = payload(START + 5 * MINUTE, 25)
        data.update(
            source="oanda", basis=inst.basis, coverage=[{"start": START, "end": now - 5000}]
        )
        market.ingest(db, inst, data, received_at=now)
        publish_frame(db, inst, plan, "M5", now)
        assert status(db, inst, "M5")["initialized"]
        assert status(db, inst, "M5")["ready"]
        assert db.get(ChartPublication, (inst.id, "M5")).start == START


def test_live_partial_minute_coverage_never_creates_fractional_history_cursor(database):
    from alerts.storage import MarketCoverage

    end = START + 30 * MINUTE
    now = end + 5000
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START, now)
        db.add(
            MarketCoverage(
                instrument_id=inst.id,
                source=inst.source,
                basis=inst.basis,
                start=START + 10 * MINUTE + 1234,
                end=end,
            )
        )
        db.flush()
        assert advance_plan(db, plan, now)
        job = db.scalar(select(ImportJob))
        assert job.start % MINUTE == job.end % MINUTE == plan.cursor % MINUTE == 0
        assert job.end == START + 11 * MINUTE


def test_unreachable_start_is_refused_without_moving_existing_start(database, monkeypatch):
    from alerts import provider_chart

    monkeypatch.setattr(provider_chart, "earliest_m1", lambda meta: START)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post(
                "/api/market-data/maintenance",
                json={"instrument": "BTCUSDT", "start_date": "2000-01-01"},
            )
            assert response.status_code == 422 and "不可达" in response.json()["detail"]
            with database.begin() as db:
                assert db.get(ChartHistoryPlan, "BTCUSDT") is None
            assert (
                client.post(
                    "/api/market-data/maintenance",
                    json={"instrument": "BTCUSDT", "start_date": "2026-09-28"},
                ).status_code
                == 200
            )
            assert (
                client.post(
                    "/api/market-data/maintenance",
                    json={"instrument": "BTCUSDT", "start_date": "2000-01-01"},
                ).status_code
                == 422
            )
            with database.begin() as db:
                assert db.get(ChartHistoryPlan, "BTCUSDT").target_start == START
    finally:
        api_module.app.dependency_overrides.clear()


def test_legacy_unreachable_plan_is_stopped_without_changing_approval_or_snapshot(
    database, monkeypatch
):
    from contextlib import contextmanager

    from alerts import provider_chart, storage
    from alerts.chart_history_plan import advance_pending_plans, plan_status

    end = START + 30 * MINUTE
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START - 86400000, end + 5000)
        market.ingest(db, inst, payload(START, 30), received_at=end + 5000)
        publish_frame(db, inst, plan, "M5", end + 5000)
        visible = read_rows(db, inst, "M5", end, 100)
        db.add(
            ImportJob(
                instrument_id=inst.id,
                start=plan.target_start,
                end=START,
                cursor=plan.target_start,
                priority=300,
                chart_plan=True,
            )
        )
    # A first-M1 probe must run without occupying the shared DB pool.
    active = 0
    original = storage.transaction

    @contextmanager
    def tracked_transaction():
        nonlocal active
        with original() as db:
            active += 1
            try:
                yield db
            finally:
                active -= 1

    monkeypatch.setattr(storage, "transaction", tracked_transaction)

    def earliest(meta):
        assert active == 0
        return START

    monkeypatch.setattr(provider_chart, "earliest_m1", earliest)
    assert advance_pending_plans() == 0
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = db.get(ChartHistoryPlan, inst.id)
        state = plan_status(db, plan, end)
        assert "不可达" in state["boundary_error"]
        assert plan.target_start == START - 86400000 and plan.realtime_enabled
        assert read_rows(db, inst, "M5", end, 100) == visible
        assert (
            state["failed"] == 1 and state["download_errors"][0]["error"] == state["boundary_error"]
        )
    monkeypatch.setattr(
        provider_chart, "earliest_m1", lambda meta: pytest.fail("confirmed boundary must be cached")
    )
    assert advance_pending_plans() == 0


def test_explicit_reachable_submission_repairs_impossible_legacy_target(database, monkeypatch):
    from alerts import provider_chart
    from alerts.chart_history_plan import validate_history_start

    monkeypatch.setattr(provider_chart, "earliest_m1", lambda meta: START)
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        join(db, inst, START - 86400000, START + 30 * MINUTE + 5000)
    assert not validate_history_start("BTCUSDT")
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post(
                "/api/market-data/maintenance",
                json={"instrument": "BTCUSDT", "start_date": "2026-09-28"},
            )
            assert response.status_code == 200
            state = response.json()
            assert state["start"] == START and state["boundary_error"] is None
            assert state["status"] == "pending" and state["realtime_enabled"]
    finally:
        api_module.app.dependency_overrides.clear()


def test_legacy_boundary_probe_failure_defers_download_and_preserves_realtime(
    database, monkeypatch
):
    from alerts import provider_chart
    from alerts.chart_history_plan import plan_status, validate_history_start

    def unavailable(meta):
        raise TimeoutError("upstream unavailable")

    monkeypatch.setattr(provider_chart, "earliest_m1", unavailable)
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        join(db, inst, START, START + 30 * MINUTE + 5000)
        db.add(
            ImportJob(
                instrument_id=inst.id,
                start=START,
                end=START + MINUTE,
                cursor=START,
                priority=300,
                chart_plan=True,
            )
        )
    assert not validate_history_start("BTCUSDT")
    with database.begin() as db:
        plan = db.get(ChartHistoryPlan, "BTCUSDT")
        assert plan.target_start == START and plan.realtime_enabled
        assert "尚未确认" in plan_status(db, plan, storage_now())["boundary_error"]
        job = db.scalar(select(ImportJob))
        assert job.status == "pending" and job.next_at > storage_now()


def storage_now():
    from alerts.storage import now_ms

    return now_ms()
