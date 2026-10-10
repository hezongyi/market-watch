"""Incremental publication keeps prior versions usable and tasks resumable."""

import pytest
from alerts import api
from alerts.history_artifacts import artifact_tick
from alerts.history_maintenance import (
    configure,
    create_run,
    next_daily,
    plan_report,
    schedule_tick,
    task_control,
    now_ms,
)
from alerts.history_versions import import_page, snapshot_rows
from alerts.market_contracts import RequestResult
from alerts.storage import DatasetMaintenance, HistoryChunk, HistoryVersion, MarketDemand
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_market_contracts import batch, identity, minute
from test_market_datasets import register


class Adapter:
    def __init__(self, *, failure=False, close="1.11"):
        self.calls = []
        self.failure, self.close = failure, close

    def page(self, raw, start, end):
        self.calls.append((start, end))
        return batch(identity=raw, window_start=start, window_end=end, observed_at=end + 5000,
            checkpoint=start if self.failure else end,
            rows=() if self.failure else tuple(minute(at, close=self.close) for at in range(start, end, 60000)),
            result=RequestResult(status="timeout" if self.failure else "data"))


def setup(database, *, end=180000):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"], overlap_minutes=1)
        version = create_run(db, identity().key, end=end, request_id="initial")
        ident = version.id
    adapter = Adapter()
    assert import_page(adapter, version_id=ident)
    while artifact_tick(ident):
        pass
    return ident


def test_incremental_run_reuses_unchanged_prefix_and_fixed_parent(database):
    parent = setup(database)
    with database.begin() as db:
        original = list(snapshot_rows(db, parent))
        old_manifest = db.get(HistoryVersion, parent).manifest
        child = create_run(db, identity().key, end=300000, request_id="update").id
    adapter = Adapter(close="1.10")
    assert import_page(adapter, version_id=child)  # Untouched prefix, no upstream.
    assert adapter.calls == []
    assert import_page(adapter, version_id=child)
    assert adapter.calls == [(120000, 300000)]
    with database.begin() as db:
        report = plan_report(db, identity().key)
        assert report["active_version_id"] == child and report["task_status"] == "deriving"
    while artifact_tick(child):
        pass
    with database.begin() as db:
        assert db.get(HistoryVersion, child).status == "published"
        rows = list(snapshot_rows(db, child))
        assert [r["close"] for r in rows] == ["1.11", "1.11", "1.10", "1.10", "1.10"]
        assert list(snapshot_rows(db, parent)) == original
        assert db.get(HistoryVersion, parent).manifest == old_manifest
        report = plan_report(db, identity().key)
        assert report["latest_version_id"] == child and report["active_version_id"] is None
        assert report["available_end"] == 300000


def test_failed_update_keeps_old_published_history_and_retry_checkpoint(database):
    parent = setup(database)
    with database.begin() as db:
        child = create_run(db, identity().key, end=300000, request_id="update").id
    failed = Adapter(failure=True)
    import_page(failed, version_id=child)
    import_page(failed, version_id=child)
    with database.begin() as db:
        report = plan_report(db, identity().key)
        assert report["latest_version_id"] == parent and report["available_end"] == 180000
        assert report["task_status"] == "retrying" and report["task_error"] == "timeout"
        assert db.get(HistoryVersion, child).cursor == 120000
        task_control(db, child, "retry")
    retry = Adapter()
    assert import_page(retry, version_id=child)
    assert retry.calls == [(120000, 300000)]


def test_legacy_precision_failure_retry_freezes_rule_before_accepting_rows(database):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        ident = create_run(db, identity().key, end=120000, request_id="legacy-precision").id
        version = db.get(HistoryVersion, ident)
        version.manifest = {}
        version.status = "configuration_error"
        version.error = "price_precision_overflow"
        task_control(db, ident, "retry")
        assert version.manifest["price_precision"] == 5
        assert version.manifest["price_rule_version"] == "dataset-precision-half-up-v1"
        assert version.manifest["price_rule_activation"]["previous_error"] == "price_precision_overflow"
    assert import_page(Adapter(close="1.111111"), version_id=ident)
    with database.begin() as db:
        assert list(snapshot_rows(db, ident))[0]["close"] == "1.11111"


def test_legacy_precision_retry_rejects_active_writer_lease(database):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        ident = create_run(db, identity().key, end=120000, request_id="legacy-precision-lease").id
        version = db.get(HistoryVersion, ident)
        version.manifest = {}
        version.status = "configuration_error"
        version.error = "price_precision_overflow"
        version.lease_token, version.lease_until = "active", now_ms() + 60000
        with pytest.raises(ValueError, match="有效写入租约"):
            task_control(db, ident, "retry")


def test_explicit_recheck_reuses_both_sides_and_preserves_unknown_rules(database):
    parent = setup(database, end=300000)
    with database.begin() as db:
        child = create_run(db, identity().key, kind="recheck", start=60000,
                           end=120000, request_id="recheck").id
    adapter = Adapter(close="1.10")
    for _ in range(3):
        assert import_page(adapter, version_id=child)
    assert adapter.calls == [(60000, 120000)]
    with database.begin() as db:
        assert [r["close"] for r in snapshot_rows(db, child)] == ["1.11", "1.10", "1.11", "1.11", "1.11"]
        assert len(db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == child)).all()) == 3
        assert len(list(snapshot_rows(db, parent))) == 5


def test_request_retry_is_idempotent_even_as_default_cutoff_changes(database, monkeypatch):
    import alerts.history_maintenance as maintenance

    monkeypatch.setattr(maintenance, "now_ms", lambda: 305000)
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        version = create_run(db, identity().key, request_id="timeout-retry")
        fixed = version.id, version.end
    monkeypatch.setattr(maintenance, "now_ms", lambda: 365000)
    with database.begin() as db:
        repeat = create_run(db, identity().key, request_id="timeout-retry")
        assert (repeat.id, repeat.end) == fixed
        with pytest.raises(ValueError, match="提交标识"):
            create_run(db, identity().key, end=120000, request_id="timeout-retry")


def test_pause_task_waits_for_checkpoint_and_drops_inflight_result(database):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        ident = create_run(db, identity().key, end=120000, request_id="initial").id

    class PauseDuringRequest(Adapter):
        def page(self, raw, start, end):
            with database.begin() as db:
                task_control(db, ident, "pause")
                assert db.get(HistoryVersion, ident).status == "running"
            return super().page(raw, start, end)

    assert import_page(PauseDuringRequest(), version_id=ident)
    with database.begin() as db:
        version = db.get(HistoryVersion, ident)
        assert version.status == "paused" and version.cursor == 0
        assert db.scalar(select(HistoryChunk)) is None
        task_control(db, ident, "resume")
    assert import_page(Adapter(), version_id=ident)
    while artifact_tick(ident):
        pass
    with database.begin() as db:
        assert db.get(HistoryVersion, ident).status == "published"
        with pytest.raises(ValueError, match="不可改写"):
            task_control(db, ident, "retry")


def test_daily_schedule_is_separate_from_pause_and_read_has_no_live_demand(database):
    with database.begin() as db:
        register(db)
        plan = configure(db, identity().key, target_start=0, timeframes=["M1"])
        plan.next_at, plan.paused = 1, True
    assert not schedule_tick()
    with database.begin() as db:
        db.get(DatasetMaintenance, identity().key).paused = False
    assert schedule_tick()
    assert not schedule_tick()
    with database.begin() as db:
        report = plan_report(db, identity().key)
        assert report["active_version_id"] and report["next_at"] > 1
        assert db.scalar(select(MarketDemand)) is None


def test_dst_daily_maintenance_uses_local_wall_clock():
    from datetime import datetime
    def at(s):
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    assert next_daily(at("2026-03-07T23:00:00+00:00"), 17 * 60, "America/New_York") == at("2026-03-08T21:00:00+00:00")
    assert next_daily(at("2026-10-31T23:00:00+00:00"), 17 * 60, "America/New_York") == at("2026-11-01T22:00:00+00:00")


def test_api_plan_task_and_control_keep_management_reads_pure(database):
    with database.begin() as db:
        register(db)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            root = f"/api/market-data/datasets/{identity().key}"
            response = client.post(root + "/maintenance", json={"target_start": 0, "timeframes": ["M1", "H4"]})
            assert response.status_code == 200 and response.json()["configured"]
            request = {"request_id": "initial", "end": 120000}
            task = client.post(root + "/tasks", json=request).json()
            assert client.post(root + "/tasks", json=request).json()["id"] == task["id"]
            paused = client.post(f"/api/market-data/tasks/{task['id']}/control", json={"action": "pause"})
            assert paused.json()["status"] == "paused"
            assert client.post(root + "/maintenance/control", json={"action": "pause"}).json()["paused"]
            assert client.get(root + "/maintenance").json()["task_status"] == "paused"
            assert client.post(root + "/maintenance", json={"target_start": 0, "timeframes": ["invalid"]}).status_code == 422
        with database.begin() as db:
            assert db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()


def test_http_stale_plan_returns_conflict_and_preserves_saved_configuration(database):
    from alerts.history_maintenance import plan_report

    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"], frequency="once")
        initial = plan_report(db, identity().key)["configuration_revision"]
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            body = {"target_start": 0, "timeframes": ["M1", "H4"], "frequency": "once",
                "expected_configuration_revision": initial}
            response = client.post(f"/api/market-data/datasets/{identity().key}/maintenance", json=body)
            assert response.status_code == 200
            saved = response.json()
            stale = client.post(f"/api/market-data/datasets/{identity().key}/maintenance",
                json={**body, "timeframes": ["M1", "D1"]})
            assert stale.status_code == 409 and stale.json()["detail"]["code"] == "MAINTENANCE_CHANGED"
            assert client.get(f"/api/market-data/datasets/{identity().key}/maintenance").json() == saved
    finally:
        api.app.dependency_overrides.clear()


def test_maintenance_success_waits_for_all_fixed_requested_artifacts(database):
    from alerts.data_center import task_list
    from alerts.history_versions import version_report
    from alerts.storage import HistoryRun

    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        ident = create_run(db, identity().key, end=120000, request_id="initial").id
    import_page(Adapter(), version_id=ident)
    with database.begin() as db:
        manifest = db.get(HistoryVersion, ident).manifest
        assert plan_report(db, identity().key)["last_success"] is None
        assert version_report(db, ident)["status"] == "published"
        assert task_list(db)["items"][0]["status"] == "deriving"
        assert task_list(db)["items"][0]["controllable"]
        with pytest.raises(ValueError, match="已有维护任务"):
            create_run(db, identity().key, end=180000, request_id="too-soon")
    assert artifact_tick(ident)  # H4 publishes before M1.
    with database.begin() as db:
        assert db.get(HistoryRun, ident).completed_at is None
        task_control(db, ident, "pause")
        assert plan_report(db, identity().key)["task_status"] == "paused"
    assert not artifact_tick(ident)
    with database.begin() as db:
        task_control(db, ident, "resume")
    assert artifact_tick(ident)
    with database.begin() as db:
        report = plan_report(db, identity().key)
        assert report["active_version_id"] is None and report["last_success"] is not None
        assert db.get(HistoryRun, ident).completed_at == report["last_success"]
        assert task_list(db)["items"][0]["status"] == "published"
        assert db.get(HistoryVersion, ident).manifest == manifest


def test_cancel_artifact_stage_preserves_m1_and_partial_periods(database):
    from alerts.history_artifacts import read_artifact
    from alerts.history_versions import version_report

    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        ident = create_run(db, identity().key, end=120000, request_id="initial").id
    import_page(Adapter(), version_id=ident)
    assert artifact_tick(ident)
    with database.begin() as db:
        task_control(db, ident, "cancel")
        assert version_report(db, ident)["task_status"] == "cancelled"
        assert db.get(HistoryVersion, ident).status == "published"
        assert len(read_artifact(db, ident, "H4")) == 1
        assert plan_report(db, identity().key)["active_version_id"] is None
        with pytest.raises(ValueError, match="已取消任务"):
            task_control(db, ident, "resume")
        create_run(db, identity().key, end=180000, request_id="new")
    assert not artifact_tick(ident)


def test_scheduler_recovers_completion_after_artifact_publish_crash(database, monkeypatch):
    import alerts.history_maintenance as maintenance

    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        ident = create_run(db, identity().key, end=120000, request_id="initial").id
    import_page(Adapter(), version_id=ident)
    finish = maintenance.finish_run
    monkeypatch.setattr(maintenance, "finish_run", lambda *_: False)
    while artifact_tick(ident):
        pass
    with database.begin() as db:
        assert plan_report(db, identity().key)["active_version_id"] == ident
        assert plan_report(db, identity().key)["last_success"] is None
    monkeypatch.setattr(maintenance, "finish_run", finish)
    assert schedule_tick()
    with database.begin() as db:
        assert plan_report(db, identity().key)["active_version_id"] is None
        assert plan_report(db, identity().key)["last_success"] is not None
