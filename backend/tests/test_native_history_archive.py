"""Real managed pipeline, independent windows, immutable repairs and fencing."""

from datetime import UTC, datetime

import pytest
from alerts import fixed_indicators
from alerts.chart_api import DataQuery, data_sync
from alerts.history_artifacts import artifact_tick, read_artifact
from alerts.history_maintenance import configure, create_run, plan_report, task_control
from alerts.history_mode_artifacts import date_bounds
from alerts.history_versions import import_page
from alerts.market_contracts import NativeCandleBatch
from alerts.source_registry import link_frame_source
from alerts.storage import DatasetMaintenance, HistoryChunk, HistoryFrameRun, HistoryVersion
from sqlalchemy import select
from test_history_modes import mode_identity, native_bar, native_identity, register_mode


def stamp(day):
    return int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp() * 1000)


def day(day, **changes):
    left, right = date_bounds(day, "D1")
    return native_bar(start=left, end=right, source_label=day, trading_date=day, **changes)


class Adapter:
    def __init__(self, data):
        self.data, self.calls = data, []

    def native_page(self, identity, start, end):
        frame = identity.parameters["timeframe"]
        self.calls.append((frame, start, end))
        value = self.data[frame]
        if callable(value):
            return value(identity, start, end)
        if isinstance(value, Exception):
            raise value
        return NativeCandleBatch(identity=identity, timeframe=frame,
            window_start=start, window_end=end, checkpoint=end, observed_at=end,
            result={"status": "data" if value else "empty_success"},
            rows=value, volume_kind="quantity", volume_unit="shares")


def prepare(database, *, mode="base_d1", outputs=("D1", "W1", "MN"), start="2023-12-01", frame_plan=None,
            adjustment="none"):
    parent = mode_identity(mode, adjustment=adjustment)
    with database.begin() as db:
        dataset, _ = register_mode(db, parent)
        for frame in ("D1",) if mode == "base_d1" else outputs:
            link_frame_source(db, dataset, frame, native_identity(frame, parent))
        configure(db, dataset.id, target_start=stamp(start), timeframes=list(outputs),
            timezone="Asia/Shanghai", daily_minute=1080, frame_plan=frame_plan)
    return parent.key


def run(database, dataset, cutoff, adapter, request_id="first"):
    with database.begin() as db:
        version = create_run(db, dataset, end=stamp(cutoff), request_id=request_id).id
    drain(version, adapter)
    return version


def drain(version, adapter):
    for _ in range(30):
        if not import_page(adapter, version_id=version):
            break
    else:
        raise AssertionError("archive failed to finish")
    for _ in range(100):
        if not artifact_tick(version):
            return
    raise AssertionError("artifacts failed to finish")


def test_d1_cross_year_week_month_sparse_input_and_fixed_indicator_without_m1(database):
    dataset = prepare(database)
    adapter = Adapter({"D1": [day("2023-12-28", open="10", high="14", low="9", close="13"),
        day("2023-12-29", open="13", high="15", low="11", close="14"),
        day("2024-01-02", open="14", high="16", low="12", close="15"),
        day("2024-01-04", open="15", high="18", low="13", close="17")]})
    version = run(database, dataset, "2024-01-05", adapter)
    assert [call[0] for call in adapter.calls] == ["D1"]
    with database.begin() as db:
        assert db.scalar(select(HistoryChunk).where(HistoryChunk.timeframe == "M1")) is None
        weeks = read_artifact(db, version, "W1")
        assert [(bar["open"], bar["high"], bar["low"], bar["close"]) for bar in weeks] == [
            ("10", "15", "9", "14"), ("14", "18", "12", "17")]
        assert weeks[0]["volume"] == "10" and weeks[0]["complete"]
        assert not weeks[1]["complete"]
        months = read_artifact(db, version, "MN")
        assert months[0]["start"] == stamp("2023-12-01") and months[0]["complete"]
        assert months[1]["start"] == stamp("2024-01-01") and not months[1]["complete"]
    spec = {"id": "sma", "name": "SMA", "params": {"period": 2}}
    query = DataQuery(instrument=version, series_kind="history", timeframe="D1", limit=10,
                     indicators=[spec])
    pending = data_sync(query)
    job = pending["indicator_progress"][0]["run_id"]
    for _ in range(20):
        if not fixed_indicators.indicator_tick(job):
            break
    result = data_sync(query)
    assert result["future"] == [] and not result["pending"]
    assert result["indicators"][0]["series"][0]["values"][-1]["value"] == 16
    assert result["bars"][0]["chart_time"] == stamp("2023-12-28")


def test_native_periods_have_independent_windows_and_never_derive_native_week(database):
    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5", "W1"))
    m5 = native_bar(timeframe="M5", start=stamp("2024-01-03"),
        end=stamp("2024-01-03") + 300000, source_label="2024-01-03 00:05")
    week = native_bar(timeframe="W1", start=stamp("2023-12-25"), end=stamp("2024-01-01"),
        source_label="2023-12-25", trading_date="2023-12-25", close="10")
    adapter = Adapter({"D1": [day("2023-12-01"), day("2024-01-03")], "M5": [m5], "W1": [week]})
    version = run(database, dataset, "2024-01-05", adapter)
    assert sorted(call[0] for call in adapter.calls) == ["D1", "M5", "W1"]
    with database.begin() as db:
        facts = db.get(HistoryVersion, version).manifest["frames"]
        assert facts["D1"]["first"] == stamp("2023-12-01")
        assert facts["M5"]["first"] == stamp("2024-01-03")
        assert read_artifact(db, version, "W1")[0]["close"] == "10"
        assert read_artifact(db, version, "W1")[0]["provenance"] == "native"


def test_rolling_window_keeps_old_rows_and_revision_preserves_old_snapshot(database):
    dataset = prepare(database, mode="native_periods", outputs=("D1",))
    first = run(database, dataset, "2024-01-04", Adapter({"D1": [day("2023-12-01"), day("2024-01-02")]}))
    with database.begin() as db:
        original = read_artifact(db, first, "D1")
        original_checksum = db.get(HistoryVersion, first).manifest["checksum"]
    second = run(database, dataset, "2024-01-05", Adapter({"D1": [day("2024-01-02", close="10"), day("2024-01-03")]}), "second")
    with database.begin() as db:
        rows = read_artifact(db, second, "D1")
        assert [row["trading_date"] for row in rows] == ["2023-12-01", "2024-01-02", "2024-01-03"]
        assert rows[1]["close"] == "10"
        assert read_artifact(db, first, "D1") == original
        assert db.get(HistoryVersion, first).manifest["checksum"] == original_checksum
        assert db.get(HistoryVersion, second).manifest["frames"]["D1"]["changed_from"] == stamp("2024-01-02")


def test_one_period_timeout_publishes_partial_and_keeps_previous_period(database):
    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5"))
    minute = native_bar(timeframe="M5", start=stamp("2024-01-02"), end=stamp("2024-01-02") + 300000)
    first = run(database, dataset, "2024-01-04", Adapter({"D1": [day("2024-01-02")], "M5": [minute]}))
    second = run(database, dataset, "2024-01-05", Adapter({"D1": [day("2024-01-03")], "M5": TimeoutError()}), "second")
    with database.begin() as db:
        version = db.get(HistoryVersion, second)
        assert version.status == "published" and version.manifest["result"] == "partial"
        assert version.manifest["frames"]["M5"]["status"] == "stale"
        assert version.manifest["frames"]["M5"]["observed_at"] == stamp("2024-01-04")
        assert read_artifact(db, first, "M5")[0]["close"] == read_artifact(db, second, "M5")[0]["close"]
        assert plan_report(db, dataset)["latest_version_id"] == second
        assert plan_report(db, dataset)["active_version_id"] is None


def test_first_failed_period_unavailable_all_failure_never_advances_good_version(database):
    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5"))
    first = run(database, dataset, "2024-01-04", Adapter({"D1": [day("2024-01-02")], "M5": []}))
    with database.begin() as db:
        assert db.get(HistoryVersion, first).manifest["frames"]["M5"]["status"] == "unavailable"
        with pytest.raises(ValueError, match="尚未发布"):
            read_artifact(db, first, "M5")
    second = run(database, dataset, "2024-01-05", Adapter({"D1": TimeoutError(), "M5": TimeoutError()}), "second")
    with database.begin() as db:
        assert db.get(HistoryVersion, second).status == "failed"
        assert db.get(DatasetMaintenance, dataset).latest_version_id == first


def test_cancel_during_io_discards_response_and_frame_cursor(database):
    dataset = prepare(database)
    with database.begin() as db:
        version = create_run(db, dataset, end=stamp("2024-01-05"), request_id="cancel").id

    def cancel(identity, start, end):
        with database.begin() as db:
            task_control(db, version, "cancel")
        return NativeCandleBatch(identity=identity, timeframe="D1", window_start=start,
            window_end=end, observed_at=end, checkpoint=end, rows=[day("2024-01-02")],
            result={"status": "data"}, volume_kind="quantity", volume_unit="shares")

    assert import_page(Adapter({"D1": cancel}), version_id=version)
    with database.begin() as db:
        assert db.get(HistoryVersion, version).status == "cancelled"
        assert db.get(HistoryFrameRun, (version, "D1")).cursor == stamp("2023-12-01")
        assert db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == version)) is None


@pytest.mark.parametrize("adjustment", ["none", "qfq", "hfq"])
def test_daily_refresh_detects_remote_revision_outside_recent_overlap(database, adjustment):
    dataset = prepare(database, adjustment=adjustment)
    original = [day("2024-01-02"), day("2024-01-22"), day("2024-01-23")]
    first = run(database, dataset, "2024-01-25", Adapter({"D1": original}))
    updated = Adapter({"D1": [day("2024-01-02", close="12"), *original[1:], day("2024-01-26")]})
    second = run(database, dataset, "2024-01-29", updated, "revision")
    assert updated.calls[0][1] == stamp("2023-12-01"), "daily updates must check the maintained range"
    with database.begin() as db:
        assert read_artifact(db, first, "D1")[0]["close"] == "11"
        assert read_artifact(db, second, "D1")[0]["close"] == "12"
        assert read_artifact(db, first, "W1")[0]["close"] == "11"
        assert read_artifact(db, second, "W1")[0]["close"] == "12"


def test_partial_retry_is_new_version_and_requests_only_failed_frame(database):
    import copy

    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5"))
    first = run(database, dataset, "2024-01-05", Adapter({"D1": [day("2024-01-02")], "M5": TimeoutError()}))
    with database.begin() as db:
        manifest = copy.deepcopy(db.get(HistoryVersion, first).manifest)
        retry = task_control(db, first, "retry").id
        assert retry != first
    minute = native_bar(timeframe="M5", start=stamp("2024-01-03"), end=stamp("2024-01-03") + 300000)
    adapter = Adapter({"M5": [minute]})
    drain(retry, adapter)
    assert [call[0] for call in adapter.calls] == ["M5"]
    with database.begin() as db:
        assert db.get(HistoryVersion, first).manifest == manifest
        assert db.get(HistoryVersion, retry).status == "published"
        assert read_artifact(db, retry, "D1")[0]["close"] == "11"
        assert plan_report(db, dataset)["latest_version_id"] == retry


def test_expired_owner_response_cannot_overwrite_replacement_checkpoint(database):
    from alerts.native_history_archive import _claim
    from alerts.storage import HistoryReadAttempt

    dataset = prepare(database)
    with database.begin() as db:
        version = create_run(db, dataset, end=stamp("2024-01-05"), request_id="takeover").id
    replacement = []

    def takeover(identity, start, end):
        with database.begin() as db:
            db.get(HistoryVersion, version).lease_until = 0
        replacement.append(_claim(version))
        return NativeCandleBatch(identity=identity, timeframe="D1", window_start=start,
            window_end=end, observed_at=end, checkpoint=end, rows=[day("2024-01-02")],
            result={"status": "data"}, volume_kind="quantity", volume_unit="shares")

    assert import_page(Adapter({"D1": takeover}), version_id=version)
    with database.begin() as db:
        assert db.get(HistoryVersion, version).lease_token == replacement[0]["token"]
        assert db.get(HistoryFrameRun, (version, "D1")).cursor == stamp("2023-12-01")
        attempts = list(db.scalars(select(HistoryReadAttempt).where(HistoryReadAttempt.version_id == version)))
        assert any(attempt.result == "interrupted" for attempt in attempts)
        assert not any(attempt.accepted for attempt in attempts)
        db.get(HistoryVersion, version).lease_until = 0
    drain(version, Adapter({"D1": [day("2024-01-02")]}))
    with database.begin() as db:
        assert db.get(HistoryVersion, version).status == "published"


def test_only_due_frame_runs_and_schedule_revision_ignores_progress(database):
    from alerts.history_maintenance import (
        MaintenanceConflict,
        configuration_revision,
        schedule_tick,
    )
    from alerts.storage import now_ms

    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5"))
    minute = native_bar(timeframe="M5", start=stamp("2024-01-02"), end=stamp("2024-01-02") + 300000)
    run(database, dataset, "2024-01-04", Adapter({"D1": [day("2024-01-02")], "M5": [minute]}))
    with database.begin() as db:
        plan = db.get(DatasetMaintenance, dataset)
        revision = configuration_revision(plan)
        plan.frame_plan = {key: {**rule, "next_due": now_ms() + (600000 if key == "D1" else -1000)}
                           for key, rule in plan.frame_plan.items()}
        plan.next_at = now_ms() - 1000
        assert configuration_revision(plan) == revision
    assert schedule_tick()
    with database.begin() as db:
        plan = db.get(DatasetMaintenance, dataset)
        version = plan.active_version_id
        assert db.get(HistoryFrameRun, (version, "D1")).status == "inherited"
        configure(db, dataset, target_start=plan.target_start, timeframes=plan.timeframes,
                  daily_minute=1000, expected_configuration_revision=revision)
    with pytest.raises(MaintenanceConflict):
        with database.begin() as db:
            plan = db.get(DatasetMaintenance, dataset)
            configure(db, dataset, target_start=plan.target_start, timeframes=plan.timeframes,
                      daily_minute=900, expected_configuration_revision=revision)
    adapter = Adapter({"M5": [minute]})
    drain(version, adapter)
    assert [call[0] for call in adapter.calls] == ["M5"]


def test_all_failed_retry_restores_active_task_and_can_publish(database):
    dataset = prepare(database)
    version = run(database, dataset, "2024-01-05", Adapter({"D1": TimeoutError()}))
    with database.begin() as db:
        assert db.get(HistoryVersion, version).status == "failed"
        assert task_control(db, version, "retry").id == version
        assert db.get(DatasetMaintenance, dataset).active_version_id == version
    drain(version, Adapter({"D1": [day("2024-01-02")]}))
    with database.begin() as db:
        assert db.get(HistoryVersion, version).status == "published"


@pytest.mark.parametrize("previous_rows, expected", [(False, "unavailable"), (True, "stale")])
def test_not_due_failed_frame_keeps_freshness_and_does_not_block_completion(database, previous_rows, expected):
    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5"))
    if previous_rows:
        minute = native_bar(timeframe="M5", start=stamp("2024-01-02"), end=stamp("2024-01-02") + 300000)
        run(database, dataset, "2024-01-04", Adapter({"D1": [day("2024-01-02")], "M5": [minute]}))
    parent = run(database, dataset, "2024-01-05", Adapter({"D1": [day("2024-01-03")], "M5": TimeoutError()}), "partial")
    with database.begin() as db:
        child = create_run(db, dataset, end=stamp("2024-01-06"), request_id="only-daily", requested_frames=["D1"]).id
    drain(child, Adapter({"D1": [day("2024-01-03"), day("2024-01-04")]}))
    with database.begin() as db:
        version = db.get(HistoryVersion, child)
        assert version.manifest["frames"]["M5"]["status"] == expected
        assert version.manifest["frames"]["M5"]["inherited_version"] == parent
        assert version.manifest["result"] == "partial"
        assert plan_report(db, dataset)["active_version_id"] is None


def test_native_update_rechecks_available_window_not_only_last_two_bars(database):
    dataset = prepare(database, mode="native_periods", outputs=("M5",))
    base = stamp("2024-01-02")
    rows = [native_bar(timeframe="M5", start=base + index * 300000, end=base + (index + 1) * 300000)
            for index in range(10)]
    first = run(database, dataset, "2024-01-04", Adapter({"M5": rows}))
    revised = [row.model_copy(update={"close": "12"}) if index == 2 else row for index, row in enumerate(rows)]

    def current_window(identity, start, end):
        return NativeCandleBatch(identity=identity, timeframe="M5", window_start=start,
            window_end=end, checkpoint=end, observed_at=end,
            rows=[row for row in revised if start <= row.start < end], result={"status": "data"},
            volume_kind="quantity", volume_unit="shares")

    second = run(database, dataset, "2024-01-05", Adapter({"M5": current_window}), "window-revision")
    with database.begin() as db:
        assert read_artifact(db, first, "M5")[2]["close"] == "11"
        assert read_artifact(db, second, "M5")[2]["close"] == "12"


def test_frame_target_can_precede_top_level_and_explicit_backfill_keeps_requested_bounds(database):
    dataset = prepare(database, frame_plan={"D1": {"target_start": stamp("2023-11-01")}})
    with database.begin() as db:
        version = create_run(db, dataset, end=stamp("2024-01-05"), request_id="independent").id
        assert db.get(HistoryFrameRun, (version, "D1")).start == stamp("2023-11-01")
        assert db.get(HistoryVersion, version).start == stamp("2023-11-01")
    adapter = Adapter({"D1": [day("2023-11-02"), day("2024-01-02")]})
    drain(version, adapter)
    with database.begin() as db:
        explicit = create_run(db, dataset, kind="backfill", start=stamp("2023-10-01"),
                              end=stamp("2023-11-01"), request_id="explicit").id
        frame = db.get(HistoryFrameRun, (explicit, "D1"))
        assert frame.start == stamp("2023-10-01") and frame.end == stamp("2023-11-01")


@pytest.mark.parametrize('family,kind,first_value,revised_value,expected_first,expected_second', [
    ('sina-a', 'sina_qfq_factor', '2', '4', '5', '2.5'),
    ('sina-hk', 'sina_qfq_factor', '0.5', '0.25', '5.0', '2.50'),
    ('yfinance', 'yahoo_adj_close_ratio', '0.5', '0.25', '5.0', '2.50'),
])
def test_qfq_basis_revision_freezes_raw_and_old_artifacts(database, family, kind,
        first_value, revised_value, expected_first, expected_second):
    import json

    from alerts.history_artifacts import chart_page
    from alerts.series_access import metadata
    from alerts.source_history_store import raw_chunk

    parent = mode_identity(source_family=family)
    with database.begin() as db:
        dataset, _ = register_mode(db, parent)
        link_frame_source(db, dataset, 'D1', native_identity('D1', parent))
        configure(db, dataset.id, target_start=stamp('2024-01-01'), timeframes=['D1'],
            timezone='Asia/Shanghai', daily_minute=1080)
    def rows(value):
        return [day('2024-01-02', close='10', adjustment_basis={'kind': kind, 'value': value})]
    first = run(database, parent.key, '2024-01-04', Adapter({'D1': rows(first_value)}))
    second = run(database, parent.key, '2024-01-05', Adapter({'D1': rows(revised_value)}), 'revision')
    with database.begin() as db:
        assert read_artifact(db, first, 'D1')[0]['close'] == expected_first
        assert read_artifact(db, second, 'D1')[0]['close'] == expected_second
        for version, value in [(first, first_value), (second, revised_value)]:
            raw = json.loads(raw_chunk(db, db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == version))))
            assert raw[0]['close'] == '10' and raw[0]['adjustment_basis']['value'] == value
            assert chart_page(db, version, 'D1')['adjustment_view'] == 'qfq'
            assert metadata(db, version, 'history')['adjustment_view'] == 'qfq'


def test_missing_qfq_basis_is_terminal_visible_and_does_not_starve_healthy_artifacts(database):
    from alerts.history_artifacts import artifact_report
    from alerts.storage import DatasetMaintenance
    parent = mode_identity(source_family='yfinance')
    with database.begin() as db:
        dataset, _ = register_mode(db, parent)
        link_frame_source(db, dataset, 'D1', native_identity('D1', parent))
        configure(db, dataset.id, target_start=stamp('2024-01-01'), timeframes=['D1'],
            timezone='Asia/Shanghai', daily_minute=1080)
    missing = run(database, parent.key, '2024-01-04', Adapter({'D1': [day('2024-01-02')]}))
    healthy_dataset = prepare(database)
    healthy = run(database, healthy_dataset, '2024-01-05', Adapter({'D1': [day('2024-01-02')]}))
    with database.begin() as db:
        report = artifact_report(db, missing)[0]
        assert report['status'] == 'unavailable' and report['manifest']['raw_preserved']
        assert db.get(DatasetMaintenance, parent.key).active_version_id is None
        assert read_artifact(db, healthy, 'D1')


def test_pending_legacy_artifact_resumes_using_its_original_rule(database):
    from alerts.storage import HistoryArtifact
    parent = mode_identity(source_family='yfinance')
    with database.begin() as db:
        dataset, _ = register_mode(db, parent)
        link_frame_source(db, dataset, 'D1', native_identity('D1', parent))
        configure(db, dataset.id, target_start=stamp('2024-01-01'), timeframes=['D1'],
            timezone='Asia/Shanghai', daily_minute=1080)
        version = create_run(db, dataset.id, end=stamp('2024-01-04'), request_id='old').id
    for _ in range(5):
        if not import_page(Adapter({'D1': [day('2024-01-02')]}), version_id=version):
            break
    with database.begin() as db:
        artifact = db.scalar(select(HistoryArtifact).where(HistoryArtifact.version_id == version))
        artifact.rule_version = 'source-trading-date-artifact-v1'
    while artifact_tick(version):
        pass
    with database.begin() as db:
        row = read_artifact(db, version, 'D1')[0]
        assert row['close'] == '11'
        assert row['rule_version'] == 'source-trading-date-artifact-v1'
