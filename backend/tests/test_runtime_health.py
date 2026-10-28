"""Health is actual loop progress, never an independent timer or retry start."""

import pytest
from alerts import runtime_health as health
from alerts.storage import Preference, transaction


def test_progress_is_bounded_idle_is_healthy_and_stuck_roles_expire(database, monkeypatch):
    clock = [100000]
    monkeypatch.setattr(health, "now_ms", lambda: clock[0])
    reporter = health.Progress("market", "chart_alert", "boot-one")
    reporter.claim()
    reporter.record()
    clock[0] += 1000
    reporter.record()
    with database() as db:
        value = db.get(Preference, health.key("chart_alert")).value
        assert value["checked_at"] == 100000
        assert health.summary(db, ("chart_alert",), at=114999)[0]["state"] == "idle"
        assert health.summary(db, ("chart_alert",), at=115000)[0]["state"] == "stale"
    clock[0] = 105000
    reporter.record()
    with database() as db:
        assert db.get(Preference, health.key("chart_alert")).value["checked_at"] == 105000


def test_retry_start_and_owner_wait_do_not_clear_an_unrecovered_fault(database, monkeypatch):
    clock = [100000]
    monkeypatch.setattr(health, "now_ms", lambda: clock[0])
    reporter = health.Progress("market", "pricing", "boot-one")
    reporter.claim()
    reporter.record()
    clock[0] += 1
    reporter.record(state="degraded", error=TimeoutError("private"))
    clock[0] += 1
    reporter.record(state="running", completed=False)
    clock[0] += 1
    reporter.record(state="waiting_input")
    with database() as db:
        value = db.get(Preference, health.key("pricing")).value
        assert value["last_success_at"] == 100000
        assert value["error_type"] == "TimeoutError"
    reporter.record(state="idle")
    with database() as db:
        value = db.get(Preference, health.key("pricing")).value
        assert value["last_success_at"] == clock[0] and value["error_type"] is None


def test_old_boot_completion_cannot_overwrite_replacement(database):
    old = health.Progress("market", "chart_alert", "old")
    old.claim()
    replacement = health.Progress("market", "chart_alert", "new")
    replacement.claim()
    replacement.record(state="degraded", error="RuntimeError")
    old.record()
    with database() as db:
        value = db.get(Preference, health.key("chart_alert")).value
        assert value["boot_id"] == "new" and value["error_type"] == "RuntimeError"


def test_replaced_boot_cannot_start_a_business_transaction(database):
    old = health.Progress("market", "chart_alert", "old")
    old.claim()
    replacement = health.Progress("market", "chart_alert", "new")
    replacement.claim()

    with health.reporting(old), transaction() as db:
        with pytest.raises(health.RuntimeOwnershipLost):
            health.assert_current(db)

    with health.reporting(replacement), transaction() as db:
        health.assert_current(db)


def test_missing_first_progress_expires_and_context_is_restored(database, monkeypatch):
    monkeypatch.setattr(health, "now_ms", lambda: 100000)
    reporter = health.Progress("market", "pricing", "boot")
    reporter.claim()
    with database() as db:
        assert health.summary(db, ("pricing",), at=159999)[0]["state"] == "starting"
        assert health.summary(db, ("pricing",), at=160000)[0]["state"] == "stale"
        assert health.summary(db, ("chart_alert",))[0]["state"] == "missing"
    with health.reporting(reporter):
        health.progress()
    assert health.CURRENT.get() is None
