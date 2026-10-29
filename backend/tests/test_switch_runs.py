"""Switch runs are the only durable record that unlocks the 30-day cleanup."""

from datetime import UTC, datetime, timedelta, timezone

import pytest
from alerts import switch_runs
from alerts.storage import MarketSwitchRun
from sqlalchemy import func, select

DAY = datetime(2026, 10, 28, 12, tzinfo=UTC)


def scheduled(minutes=0):
    return DAY + timedelta(minutes=minutes)


def run(kind="composite", composite_id=None, minutes=0):
    return switch_runs.start(kind, composite_id=composite_id, scheduled_for=scheduled(minutes))


def succeeded(minutes=0):
    row = run(minutes=minutes)
    switch_runs.record_shadow(row["id"], {"checks": 1})
    switch_runs.record_activation(row["id"], {"revision": "r2"})
    return switch_runs.set_state(row["id"], "succeeded")


def test_start_reuses_the_row_scheduled_for_the_same_identity(database):
    first = run(composite_id="c1")
    assert first["state"] == "preparing"
    assert first["unlocked"] is False
    assert run(composite_id="c1")["id"] == first["id"]
    assert run(composite_id="c1", minutes=1)["id"] != first["id"]
    assert run(composite_id="c2")["id"] != first["id"]
    assert run(kind="rollback", composite_id="c1")["id"] != first["id"]
    assert run(composite_id="c1", minutes=1)["scheduled_for"] == int(
        (DAY + timedelta(minutes=1)).timestamp() * 1000)
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 4
    assert switch_runs.get(first["id"])["id"] == first["id"]
    assert switch_runs.get("missing") is None


def test_state_machine_only_moves_forward(database):
    row = run()
    assert switch_runs.set_state(row["id"], "shadow_ready", phase="shadow")["phase"] == "shadow"
    assert switch_runs.set_state(row["id"], "activating")["started_at"] is not None
    done = switch_runs.set_state(row["id"], "succeeded", phase="activated")
    assert done["state"] == "succeeded" and done["unlocked"] is True
    assert done["finished_at"] is not None
    for state in ("preparing", "shadow_ready", "activating", "partial", "failed"):
        with pytest.raises(ValueError, match="非法状态迁移"):
            switch_runs.set_state(row["id"], state)
    assert switch_runs.get(row["id"])["state"] == "succeeded"


def test_unreachable_transitions_are_rejected(database):
    row = run()
    with pytest.raises(ValueError, match="非法状态迁移"):
        switch_runs.set_state(row["id"], "activating")
    with pytest.raises(ValueError, match="未知的切换状态"):
        switch_runs.set_state(row["id"], "done")
    with pytest.raises(ValueError, match="不存在"):
        switch_runs.set_state("missing", "shadow_ready")
    failed = switch_runs.set_state(row["id"], "failed", error_summary={"reason": "prepare"})
    assert failed["state"] == "failed" and failed["unlocked"] is False
    assert failed["error_summary"] == {"reason": "prepare"}
    with pytest.raises(ValueError, match="非法状态迁移"):
        switch_runs.set_state(row["id"], "shadow_ready")


def test_activating_can_end_partial(database):
    row = run()
    switch_runs.set_state(row["id"], "shadow_ready")
    switch_runs.set_state(row["id"], "activating")
    partial = switch_runs.set_state(row["id"], "partial", error_summary={"stuck": ["c1"]})
    assert partial["state"] == "partial" and partial["unlocked"] is False
    with pytest.raises(ValueError, match="非法状态迁移"):
        switch_runs.set_state(row["id"], "succeeded")


def test_unlocked_runs_returns_only_succeeded(database):
    preparing = run(minutes=0)
    switch_runs.set_state(run(minutes=1)["id"], "failed")
    partial = run(minutes=2)
    switch_runs.set_state(partial["id"], "shadow_ready")
    switch_runs.set_state(partial["id"], "activating")
    switch_runs.set_state(partial["id"], "partial")
    older = succeeded(minutes=3)
    newer = succeeded(minutes=4)
    unlocked = switch_runs.unlocked_runs()
    assert [item["id"] for item in unlocked] == [older["id"], newer["id"]]
    assert all(item["state"] == "succeeded" and item["unlocked"] for item in unlocked)
    assert preparing["id"] not in {item["id"] for item in unlocked}
    assert partial["id"] not in {item["id"] for item in unlocked}
    assert len(switch_runs.unlocked_runs(limit=1)) == 1


def test_shadow_and_activation_records_are_persisted(database):
    row = run()
    assert switch_runs.record_shadow(row["id"], {"samples": 5})["state"] == "shadow_ready"
    activated = switch_runs.record_activation(row["id"], {"revision": "r2"})
    assert activated["state"] == "activating"
    assert activated["shadow_report"] == {"samples": 5}
    assert activated["activation"] == {"revision": "r2"}
    assert switch_runs.record_shadow(row["id"], {"samples": 6})["state"] == "activating"


def test_retention_claim_and_release_are_idempotent(database):
    row = succeeded()
    first = switch_runs.claim_retention(row["id"], dry_run=True)
    batch = first["retention"]
    assert batch["state"] == "running" and batch["dry_run"] is True and batch["attempts"] == 1
    again = switch_runs.claim_retention(row["id"], dry_run=True)["retention"]
    assert again["batch_id"] == batch["batch_id"] and again["claimed_at"] == batch["claimed_at"]

    interrupted = switch_runs.release_retention(
        row["id"], outcome="interrupted", stats={"done": 3})["retention"]
    assert interrupted["state"] == "interrupted" and interrupted["stats"] == {"done": 3}
    resumed = switch_runs.claim_retention(row["id"], dry_run=True)["retention"]
    assert resumed["batch_id"] == batch["batch_id"] and resumed["attempts"] == 2
    assert resumed["stats"] == {"done": 3}

    done = switch_runs.release_retention(
        row["id"], outcome="completed", stats={"done": 7})["retention"]
    assert done["state"] == "completed" and done["stats"] == {"done": 7}
    repeated = switch_runs.release_retention(
        row["id"], outcome="completed", stats={"done": 99})["retention"]
    assert repeated == done
    assert switch_runs.claim_retention(row["id"], dry_run=True)["retention"] == done

    real = switch_runs.claim_retention(row["id"], dry_run=False)["retention"]
    assert real["batch_id"] != batch["batch_id"] and real["dry_run"] is False
    assert real["stats"] == {}


def test_retention_requires_a_succeeded_run(database):
    row = run()
    with pytest.raises(ValueError, match="succeeded"):
        switch_runs.claim_retention(row["id"], dry_run=True)
    with pytest.raises(ValueError, match="没有清理批次"):
        switch_runs.release_retention(row["id"], outcome="completed", stats={})
    with pytest.raises(ValueError, match="未知的清理结果"):
        switch_runs.release_retention(succeeded()["id"], outcome="aborted", stats={})


def test_scheduled_for_is_stored_as_utc_instants(database):
    local = datetime(2026, 10, 28, 20, tzinfo=timezone(timedelta(hours=8)))
    aware = switch_runs.start("composite", scheduled_for=local)
    assert aware["scheduled_for"] == int(datetime(2026, 10, 28, 12, tzinfo=UTC).timestamp() * 1000)
    naive = switch_runs.start("composite", scheduled_for=datetime(2026, 10, 28, 12))
    assert naive["id"] == aware["id"], "naive input is read as UTC"
    explicit = switch_runs.start("composite", scheduled_for=aware["scheduled_for"])
    assert explicit["id"] == aware["id"], "millisecond instants are accepted unchanged"
    with pytest.raises(ValueError, match="scheduled_for"):
        switch_runs.start("composite", scheduled_for=None)


def test_start_binds_the_target_revision(database):
    row = switch_runs.start("composite", composite_id="c1", previous_revision_id="r1",
                            target_revision_id="r2", scheduled_for=scheduled())
    assert (row["previous_revision_id"], row["target_revision_id"]) == ("r1", "r2")
    assert row["attempts"] == 0
    reused = switch_runs.start("composite", composite_id="c1", target_revision_id="r3",
                               scheduled_for=scheduled())
    assert reused["id"] == row["id"] and reused["target_revision_id"] == "r2"


def test_record_target_locks_once_switching_starts(database):
    row = run()
    bound = switch_runs.record_target(row["id"], "r2", previous_revision_id="r1")
    assert (bound["previous_revision_id"], bound["target_revision_id"]) == ("r1", "r2")
    switch_runs.record_target(row["id"], "r3")
    assert switch_runs.get(row["id"])["previous_revision_id"] == "r1"
    switch_runs.record_shadow(row["id"], {"checks": 1})
    assert switch_runs.record_target(row["id"], "r4")["target_revision_id"] == "r4"
    switch_runs.record_activation(row["id"], {"revision": "r4"})
    with pytest.raises(ValueError, match="目标修订"):
        switch_runs.record_target(row["id"], "r5")
    switch_runs.set_state(row["id"], "succeeded")
    with pytest.raises(ValueError, match="目标修订"):
        switch_runs.record_target(row["id"], "r5")
    assert switch_runs.get(row["id"])["target_revision_id"] == "r4"


def test_retry_reuses_the_run_for_the_next_tick(database):
    row = run()
    switch_runs.record_target(row["id"], "r2")
    switch_runs.record_shadow(row["id"], {"checks": 1})
    switch_runs.record_activation(row["id"], {"revision": "r2"})
    assert switch_runs.set_state(row["id"], "failed")["finished_at"] is not None
    retried = switch_runs.retry(row["id"], phase="retrying")
    assert retried["id"] == row["id"] and retried["state"] == "preparing"
    assert retried["attempts"] == 1 and retried["finished_at"] is None
    assert retried["phase"] == "retrying"
    assert retried["shadow_report"] == {"checks": 1}
    assert retried["activation"] == {"revision": "r2"}
    assert retried["target_revision_id"] == "r2"
    with pytest.raises(ValueError, match="succeeded"):
        switch_runs.claim_retention(row["id"], dry_run=False)
    assert switch_runs.start("composite", scheduled_for=scheduled())["id"] == row["id"]

    switch_runs.set_state(row["id"], "shadow_ready")
    switch_runs.set_state(row["id"], "activating")
    switch_runs.set_state(row["id"], "partial")
    assert switch_runs.retry(row["id"])["attempts"] == 2
    switch_runs.record_shadow(row["id"], {"checks": 2})
    switch_runs.record_activation(row["id"], {"revision": "r3"})
    assert switch_runs.set_state(row["id"], "succeeded")["unlocked"] is True
    assert switch_runs.claim_retention(row["id"], dry_run=True)["retention"]["state"] == "running"


def test_retry_only_applies_to_failed_or_partial(database):
    row = run()
    with pytest.raises(ValueError, match="failed/partial"):
        switch_runs.retry(row["id"])
    switch_runs.set_state(row["id"], "failed")
    with pytest.raises(ValueError, match="非法状态迁移"):
        switch_runs.set_state(row["id"], "preparing")
    switch_runs.retry(row["id"])
    switch_runs.set_state(row["id"], "shadow_ready")
    switch_runs.set_state(row["id"], "activating")
    switch_runs.set_state(row["id"], "partial")
    with pytest.raises(ValueError, match="非法状态迁移"):
        switch_runs.set_state(row["id"], "preparing")
    with pytest.raises(ValueError, match="不存在"):
        switch_runs.retry("missing")
    done = succeeded(minutes=1)
    with pytest.raises(ValueError, match="failed/partial"):
        switch_runs.retry(done["id"])
