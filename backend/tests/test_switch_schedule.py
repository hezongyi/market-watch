"""Weekly window math and the three bounded switch cycles (A04a/A04b/A13a-c)."""

import threading
from datetime import UTC, datetime

from alerts import retention_window, switch_activation, switch_runs, switch_schedule
from alerts.config import Settings
from alerts.storage import (
    CompositeActivation,
    CompositePreparation,
    MarketComposite,
    MarketSwitchRun,
)
from sqlalchemy import func, select
from test_baseline_shadow import candidate_fixture
from test_retention_window import NOW, OLD, ZERO, counts, graph
from test_retention_window import run as succeeded_run
from test_switch_activation import candidate as activation_candidate

HOUR = 3600_000
ADAPTER = object()


def at(*parts):
    """A UTC instant in the repository's millisecond form."""
    return int(datetime(*parts, tzinfo=UTC).timestamp() * 1000)


def rows(database):
    with database() as db:
        return [{"id": row.id, "kind": row.kind, "state": row.state,
                 "attempts": row.attempts, "scheduled_for": row.scheduled_for,
                 "target_revision_id": row.target_revision_id}
                for row in db.scalars(select(MarketSwitchRun).order_by(
                    MarketSwitchRun.created_at, MarketSwitchRun.id))]


def ready_prepare(target):
    """Fake preparation that records the ready candidate on the given run."""
    def prepare(composite_id, *, run_id, adapter, budget):
        assert adapter is ADAPTER
        assert budget == 7
        switch_runs.record_target(run_id, target["revision"],
                                  previous_revision_id=target["previous"])
        switch_runs.record_shadow(run_id, {"schema": "baseline-shadow-v1",
                                           "status": "ready", "ready": True, "reasons": []})
        return {"run": {"id": run_id, "state": "shadow_ready"}, "ready": True, "reasons": []}
    return prepare


def test_next_weekly_is_the_coming_sunday_0100_utc():
    # Sunday 01:00 already opened, so the coming window is a week later.
    assert switch_schedule.next_weekly(at(2026, 3, 1, 1, 0)) == at(2026, 3, 8, 1, 0)
    assert switch_schedule.next_weekly(at(2026, 3, 1, 0, 59)) == at(2026, 3, 1, 1, 0)
    assert switch_schedule.next_weekly(at(2026, 2, 28, 23, 59)) == at(2026, 3, 1, 1, 0)
    assert switch_schedule.next_weekly(at(2026, 3, 1, 1, 1)) == at(2026, 3, 8, 1, 0)


def test_due_weekly_is_the_window_that_already_opened():
    assert switch_schedule.due_weekly(at(2026, 2, 28, 23, 59)) == at(2026, 2, 22, 1, 0)
    assert switch_schedule.due_weekly(at(2026, 3, 1, 0, 59)) == at(2026, 2, 22, 1, 0)
    assert switch_schedule.due_weekly(at(2026, 3, 1, 1, 0)) == at(2026, 3, 1, 1, 0)
    assert switch_schedule.due_weekly(at(2026, 3, 1, 1, 1)) == at(2026, 3, 1, 1, 0)


def test_weekly_math_crosses_month_and_year_boundaries():
    assert switch_schedule.due_weekly(at(2026, 3, 2, 12, 0)) == at(2026, 3, 1, 1, 0)
    assert switch_schedule.due_weekly(at(2027, 1, 1, 0, 0)) == at(2026, 12, 27, 1, 0)
    assert switch_schedule.next_weekly(at(2026, 12, 31, 12, 0)) == at(2027, 1, 3, 1, 0)
    assert switch_schedule.next_weekly(at(2027, 1, 1, 0, 0)) == at(2027, 1, 3, 1, 0)


def test_a_missed_window_catches_up_once_and_never_repeats(database):
    calls = []

    def prepare(composite_id, *, run_id, adapter, budget):
        assert adapter is ADAPTER and budget == 7
        calls.append((composite_id, run_id))
        switch_runs.record_shadow(run_id, {"status": "ready", "ready": True})
        return {"run": {"id": run_id, "state": "shadow_ready"}, "ready": True, "reasons": []}

    now = at(2026, 3, 22, 12, 0)  # three windows after 2026-03-01, none of them replayed
    first = switch_schedule.shadow_cycle(now=now, composites=("comp",), prepare=prepare,
                                        adapter=ADAPTER, budget=7)
    assert first["scheduled_for"] == at(2026, 3, 22, 1, 0)
    assert first["worked"] is True
    opened = first["composites"][0]
    assert (opened["composite_id"], opened["run_id"], opened["state"], opened["status"]) == (
        "comp", calls[0][1], "shadow_ready", "ready")
    assert [row["scheduled_for"] for row in rows(database)] == [at(2026, 3, 22, 1, 0)]
    # The same window and composite reuse one run: no second 开工, no new row.
    again = switch_schedule.shadow_cycle(now=now + 60_000, composites=("comp",),
                                        prepare=prepare, adapter=ADAPTER, budget=7)
    assert again["worked"] is False
    assert again["composites"][0]["status"] == "skipped"
    assert len(calls) == 1
    assert len(rows(database)) == 1


def test_one_failing_composite_never_stops_the_other(database):
    def prepare(composite_id, *, run_id, adapter, budget):
        if composite_id == "broken":
            raise RuntimeError("supplier unavailable")
        switch_runs.record_shadow(run_id, {"status": "ready", "ready": True})
        return {"run": {"id": run_id, "state": "shadow_ready"}, "ready": True, "reasons": []}

    result = switch_schedule.shadow_cycle(now=at(2026, 3, 1, 1, 30),
                                          composites=("broken", "healthy"),
                                          prepare=prepare)
    assert [(item["composite_id"], item["status"]) for item in result["composites"]] == [
        ("broken", "error"), ("healthy", "ready")]
    # The failed composite left its run where it stopped; the healthy one is ready.
    assert {row["state"] for row in rows(database)} == {"preparing", "shadow_ready"}


def test_a_lagging_candidate_is_retried_on_the_same_run_and_never_activated(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch)
    with database.begin() as db:
        db.get(CompositePreparation, candidate).status = "pending"
    now = at(2026, 3, 1, 1, 0, 30)
    first = switch_schedule.shadow_cycle(now=now, composites=(composite,))
    assert first["composites"][0]["status"] == "not_ready", first["composites"][0]
    assert first["composites"][0]["state"] == "failed"
    # Nothing to activate while the candidate is not ready.
    assert switch_schedule.activation_cycle()["worked"] is False
    second = switch_schedule.shadow_cycle(now=now + HOUR, composites=(composite,))
    assert second["scheduled_for"] == first["scheduled_for"]
    assert second["composites"][0]["run_id"] == first["composites"][0]["run_id"]
    stored = rows(database)
    assert [row["id"] for row in stored] == [first["composites"][0]["run_id"]]
    assert stored[0]["attempts"] == 1  # the same run id was retried in place
    assert stored[0]["state"] == "failed"


def test_ready_candidate_is_activated_once_through_the_existing_path(database, monkeypatch):
    composite, old, ident, _ = activation_candidate(database, monkeypatch)
    window = switch_schedule.shadow_cycle(
        now=at(2026, 3, 1, 1, 5), composites=(composite,), budget=7, adapter=ADAPTER,
        prepare=ready_prepare({"revision": ident, "previous": old}))
    assert window["composites"][0]["status"] == "ready"
    targets, deferred = switch_schedule.activation_targets()
    assert [item["run_id"] for item in targets] == [window["composites"][0]["run_id"]]
    assert deferred == ()
    result = switch_schedule.activation_cycle()
    assert [(item["composite_id"], item["revision_id"], item["status"])
            for item in result["candidates"]] == [(composite, ident, "activated")]
    with database() as db:
        assert db.get(MarketComposite, composite).active_revision_id == ident
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 1
    # The candidate is the active revision now: no second activation, no second run.
    assert switch_schedule.activation_cycle()["worked"] is False
    with database() as db:
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 1
    assert [row["kind"] for row in rows(database)].count(switch_activation.KIND) == 1


def test_a_window_prepared_against_a_superseded_revision_is_not_activated(database, monkeypatch):
    composite, old, ident, _ = activation_candidate(database, monkeypatch)
    record = switch_runs.start("baseline_shadow", composite_id=composite,
                               previous_revision_id=ident, scheduled_for=at(2026, 3, 1, 1, 0))
    switch_runs.record_target(record["id"], ident, previous_revision_id=ident)
    switch_runs.record_shadow(record["id"], {"status": "ready", "ready": True,
                                             "reasons": []})
    assert switch_schedule.activation_targets()[0] == ()
    cycle = switch_schedule.activation_cycle()
    assert cycle["worked"] is False
    assert [item["reason"] for item in cycle["skipped"]] == ["window_superseded"]
    assert [row["kind"] for row in rows(database)] == ["baseline_shadow"]


def test_a_not_ready_report_is_deferred_without_consuming_an_attempt(database, monkeypatch):
    composite, old, ident, _ = activation_candidate(database, monkeypatch)
    record = switch_runs.start("baseline_shadow", composite_id=composite,
                               previous_revision_id=old, scheduled_for=at(2026, 3, 1, 1, 0))
    switch_runs.record_target(record["id"], ident, previous_revision_id=old)
    # baseline_shadow records the report first and only then marks the run failed,
    # so the state can name a candidate whose persisted verdict is not ready.
    switch_runs.record_shadow(record["id"], {"status": "not_ready", "ready": False,
        "reasons": [{"code": "preparation_confirming_m1", "detail": "候选修订尚未完成准备"}]})
    targets, deferred = switch_schedule.activation_targets()
    assert targets == ()
    assert [(item["run_id"], item["reason"]) for item in deferred] == [
        (record["id"], "shadow_not_ready")]
    cycle = switch_schedule.activation_cycle()
    assert cycle["worked"] is False and cycle["candidates"] == []
    assert [item["reason"] for item in cycle["skipped"]] == ["shadow_not_ready"]
    with database() as db:
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 0
    # No attempt was consumed and the run still owns its retry.
    assert [row["kind"] for row in rows(database)] == ["baseline_shadow"]
    with database() as db:
        assert db.get(MarketSwitchRun, record["id"]).state == "shadow_ready"
    # A ready flag with preparation reasons left is not a ready window either.
    switch_runs.record_shadow(record["id"], {"status": "ready", "ready": True,
        "reasons": [{"code": "preparation_publishing_periods"}]})
    assert switch_schedule.activation_targets()[1][0]["reason"] == "shadow_not_ready"
    assert switch_schedule.activation_cycle()["worked"] is False


def test_a_not_ready_window_is_never_activated_and_activates_once_when_ready(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch)
    with database.begin() as db:
        db.get(CompositePreparation, candidate).status = "pending"
    now = at(2026, 3, 1, 1, 0, 30)
    for tick in range(3):
        window = switch_schedule.shadow_cycle(now=now + tick * 60_000, composites=(composite,))
        assert window["composites"][0]["status"] == "not_ready"
        cycle = switch_schedule.activation_cycle()
        assert cycle["worked"] is False and cycle["candidates"] == []
        assert switch_schedule.activation_targets()[0] == ()
    # One run, three retries, no activation attempt while the candidate lags.
    stored = rows(database)
    assert [row["kind"] for row in stored] == ["baseline_shadow"]
    assert stored[0]["state"] == "failed" and stored[0]["attempts"] == 2
    # baseline_shadow writes the report and only then fails the run; hold the real
    # not-ready report on a shadow_ready run to stand inside that window once.
    with database.begin() as db:
        run = db.get(MarketSwitchRun, stored[0]["id"])
        assert run.shadow_report["status"] == "not_ready" and run.shadow_report["reasons"]
        run.state = "shadow_ready"
    targets, deferred = switch_schedule.activation_targets()
    assert targets == () and [item["reason"] for item in deferred] == ["shadow_not_ready"]
    assert switch_schedule.activation_cycle()["worked"] is False
    with database.begin() as db:
        db.get(MarketSwitchRun, stored[0]["id"]).state = "failed"
    with database.begin() as db:
        prep = db.get(CompositePreparation, candidate)
        prep.status, prep.cursor = "queried", prep.cutoff
    ready = switch_schedule.shadow_cycle(now=now + 600_000, composites=(composite,))
    assert ready["composites"][0]["status"] == "ready"
    cycle = switch_schedule.activation_cycle()
    assert [item["status"] for item in cycle["candidates"]] == ["activated"], cycle
    with database() as db:
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 1
        assert db.get(MarketComposite, composite).active_revision_id == candidate
    # Exactly one activation attempt for this candidate revision.
    assert switch_schedule.activation_cycle()["worked"] is False
    assert [row["kind"] for row in rows(database)].count(switch_activation.KIND) == 1


def test_failed_activation_is_recorded_once_and_not_repeated(database, monkeypatch):
    composite, old, ident, _ = activation_candidate(database, monkeypatch)
    switch_schedule.shadow_cycle(
        now=at(2026, 3, 1, 1, 5), composites=(composite,), budget=7, adapter=ADAPTER,
        prepare=ready_prepare({"revision": ident, "previous": old}))

    def freeze_fails(*args, **kwargs):
        raise ValueError("旧修订冻结失败")

    monkeypatch.setattr(switch_activation, "freeze_previous", freeze_fails)
    result = switch_schedule.activation_cycle()
    assert [item["status"] for item in result["candidates"]] == ["failed"]
    attempted = [row for row in rows(database) if row["kind"] == switch_activation.KIND]
    assert len(attempted) == 1 and attempted[0]["state"] in ("failed", "partial")
    with database() as db:
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 0
        assert db.get(MarketComposite, composite).active_revision_id == old
    # A recorded failure is retried explicitly, never by this loop.
    assert switch_schedule.activation_cycle()["worked"] is False
    assert [row["kind"] for row in rows(database)].count(switch_activation.KIND) == 1


def test_retention_off_never_reaches_the_cleanup(database):
    called = []

    def tick(**kwargs):
        called.append(kwargs)
        raise AssertionError("off must not run a cleanup pass")

    result = switch_schedule.retention_cycle(mode="off", tick=tick)
    assert result == {"mode": "off", "worked": False, "unlocked": False,
                      "reason": "retention_off", "runs": [], "report": None}
    assert called == []


def test_retention_modes_drive_the_existing_tick(database):
    calls = []

    def tick(**kwargs):
        calls.append(kwargs["dry_run"])
        return {"unlocked": False, "reason": "no_switch_run", "runs": [], "report": None}

    assert switch_schedule.retention_cycle(mode="dry_run", tick=tick)["worked"] is False
    switch_schedule.retention_cycle(mode="execute", tick=tick)
    assert calls == [True, False]


def test_dry_run_mode_reports_without_deleting_a_row(database):
    graph(database, starts=(OLD,))
    succeeded_run(database)
    before = counts(database)
    result = switch_schedule.retention_cycle(mode="dry_run", now=NOW)
    assert result["report"]["dry_run"] is True
    assert result["report"]["deleted"] == ZERO
    assert result["report"]["rows"] > 0
    assert counts(database) == before


def test_execute_mode_without_a_restore_drill_deletes_nothing(database):
    graph(database, starts=(OLD,))
    succeeded_run(database)
    before = counts(database)
    result = switch_schedule.retention_cycle(mode="execute", now=NOW)
    assert result["unlocked"] is True and result["report"]["dry_run"] is False
    assert result["report"]["deleted"] == ZERO
    assert result["report"]["skipped"][0]["reason"] == "restore_drill_missing"
    assert retention_window.restore_marker() is None
    assert counts(database) == before


def test_switch_settings_default_to_the_confirmed_policy(monkeypatch):
    monkeypatch.delenv("ALERTS_SWITCH_AUTO_ACTIVATE_ENABLED", raising=False)
    monkeypatch.delenv("ALERTS_RETENTION_MODE", raising=False)
    fresh = Settings(_env_file=None)
    assert fresh.switch_auto_activate_enabled is True
    assert fresh.retention_mode == "dry_run"
    monkeypatch.setenv("ALERTS_RETENTION_MODE", "execute")
    monkeypatch.setenv("ALERTS_SWITCH_AUTO_ACTIVATE_ENABLED", "false")
    configured = Settings(_env_file=None)
    assert configured.retention_mode == "execute"
    assert configured.switch_auto_activate_enabled is False


def test_shadow_loop_polls_until_stopped_and_survives_a_failed_composite():
    stop, cycles = threading.Event(), []

    def cycle(*, adapter, budget):
        cycles.append(adapter)
        if len(cycles) == 2:
            stop.set()
        return {"scheduled_for": 1, "worked": True,
                "composites": [{"composite_id": "broken", "status": "error",
                                "error": "RuntimeError"}]}

    switch_schedule.run_shadow(stop, adapter=ADAPTER, cycle=cycle, idle_wait=.01)
    assert cycles == [ADAPTER, ADAPTER]


def test_activation_loop_keeps_polling_and_reports_a_degraded_tick():
    stop, cycles = threading.Event(), []

    def cycle():
        cycles.append(True)
        stop.set()
        return {"worked": True, "candidates": [{"status": "failed", "error": "ValueError"}]}

    switch_schedule.run_activation(stop, cycle=cycle, idle_wait=.01)
    assert cycles == [True]
