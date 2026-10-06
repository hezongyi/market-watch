from decimal import Decimal as D

import pytest
from alerts.chart_alert_domain import Observation
from alerts.chart_alert_service import AlertConfig, Conflict, consume, create, edit
from alerts.chart_alert_service import lifecycle as apply_lifecycle
from alerts.service import acknowledge
from alerts.storage import ChartAlert, ChartAlertVersion, Notification, Outbox, SignalRow
from sqlalchemy import func, select


def config(**changes):
    return AlertConfig.model_validate({
        "name": "价格上穿", "instrument": "EURUSD", "source": "dukascopy",
        "timeframe": "M5", "max_triggers": 3,
        "condition": {"relation": "cross_up", "right": {"kind": "constant", "value": "10"}},
        **changes,
    })


def sample(i, price, *, timestamp=None):
    return Observation(f"bar:{i}", i, timestamp if timestamp is not None else i * 300_000,
                       D(price), D(10), D(price), {"revision": 1})


def test_new_events_and_independent_acknowledgements_survive_session_restarts(database):
    with database.begin() as db:
        ident = create(db, "create-1", config(notify_ntfy=True), at=300_000).id
        consume(db, ident, sample(1, 9), detected_at=300_001)
    note_ids = []
    for i, price in enumerate([11, 11, 9, 11, 9, 11, 9, 11], 2):
        with database.begin() as db:
            event = consume(db, ident, sample(i, price), detected_at=i * 300_000 + 1000)
            if event:
                note_ids.append(db.scalar(select(Notification.id).where(Notification.signal_id == event.id)))
    with database.begin() as db:
        row = db.get(ChartAlert, ident)
        assert row.count == 3 and row.status == "completed"
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 3
        assert db.scalar(select(func.count()).select_from(Outbox)) == 3
        acknowledge(db, note_ids[0])
    with database() as db:
        assert db.get(Notification, note_ids[0]).status == "acknowledged"
        assert db.get(Notification, note_ids[1]).status == "pending"
        tasks = list(db.scalars(select(Outbox).order_by(Outbox.next_at)))
        assert sorted(t.status for t in tasks) == ["cancelled", "pending", "pending"]


def test_entire_trigger_rolls_back_then_can_be_processed_once(database):
    with database.begin() as db:
        ident = create(db, "atomic", config(notify_ntfy=True), at=0).id
        consume(db, ident, sample(0, 9), detected_at=0)
    with pytest.raises(RuntimeError):
        with database.begin() as db:
            consume(db, ident, sample(1, 11), detected_at=300_000)
            raise RuntimeError("simulate process failure before commit")
    with database.begin() as db:
        assert db.get(ChartAlert, ident).count == 0
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 0
        assert consume(db, ident, sample(1, 11), detected_at=300_000) is not None
    with database.begin() as db:
        assert consume(db, ident, sample(1, 11), detected_at=300_000) is None
        assert db.get(ChartAlert, ident).count == 1


def test_create_idempotency_and_conflicting_request_identity(database):
    with database.begin() as db:
        first = create(db, "same-request", config(), at=0)
        assert create(db, "same-request", config(), at=123).id == first.id
        with pytest.raises(Conflict):
            create(db, "same-request", config(name="不同草稿"), at=123)


def test_pause_resume_and_edits_keep_count_but_restart_opens_new_run(database):
    with database.begin() as db:
        ident = create(db, "lifecycle", config(), at=0).id
        consume(db, ident, sample(0, 9), detected_at=0)
        consume(db, ident, sample(1, 11), detected_at=300_000)
        lifecycle(db, ident, 1, "pause", at=400_000)
        assert consume(db, ident, sample(2, 9), detected_at=600_000) is None
        lifecycle(db, ident, 1, "resume", at=650_000)
        # While paused the down/up sequence does not become an event on resume.
        assert consume(db, ident, sample(3, 11), detected_at=900_000) is None
        row = edit(db, ident, 1, config(max_triggers=1), at=1_000_000)
        assert row.status == "completed" and row.count == 1 and row.version == 2
        with pytest.raises(ValueError, match="次数上限"):
            lifecycle(db, ident, 2, "resume", at=1_000_000)
        lifecycle(db, ident, 2, "restart", at=1_000_000)
        assert row.run == 2 and row.count == 0 and row.status == "active"
        assert consume(db, ident, sample(4, 9), detected_at=1_200_000) is None
        assert consume(db, ident, sample(5, 11), detected_at=1_500_000) is not None
    with database() as db:
        events = list(db.scalars(select(SignalRow).order_by(SignalRow.occurred_at)))
        assert [e.evidence["run"] for e in events] == [1, 2]
        assert [e.evidence["rule_version"] for e in events] == [1, 2]
        versions = list(db.scalars(select(ChartAlertVersion).order_by(ChartAlertVersion.version)))
        assert [v.config["max_triggers"] for v in versions] == [3, 1]


def test_old_edit_response_or_worker_cannot_modify_new_version(database):
    with database.begin() as db:
        ident = create(db, "version", config(), at=0).id
        edit(db, ident, 1, config(name="新位置"), at=100)
        with pytest.raises(Conflict):
            edit(db, ident, 1, config(name="旧响应"), at=200)
        with pytest.raises(Conflict):
            consume(db, ident, sample(1, 11), expected_version=1)
        assert db.get(ChartAlert, ident).version == 2


def test_drawing_deletion_is_explicit_and_archive_retains_event_evidence(database):
    with database.begin() as db:
        ident = create(db, "drawing", config(), at=0).id
        consume(db, ident, sample(0, 9), detected_at=0)
        consume(db, ident, sample(1, 11), detected_at=300_000)
        row = lifecycle(db, ident, 1, "drawing_deleted", at=400_000)
        assert row.status == "paused" and "画线" in row.health_reason
        lifecycle(db, ident, 1, "archive", at=500_000)
        with pytest.raises(ValueError, match="删除"):
            lifecycle(db, ident, 1, "resume", at=600_000)
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


def test_late_events_are_logged_without_automatically_sending_old_alerts(database):
    with database.begin() as db:
        ident = create(db, "late", config(notify_ntfy=True), at=0).id
        consume(db, ident, sample(0, 9), detected_at=0)
        record = consume(db, ident, sample(1, 11), detected_at=600_000)
        assert record.evidence["late"] is True
        assert db.scalar(select(Outbox.status)) == "suppressed"


def test_expiration_and_incorrect_source_never_silently_monitor_another_series(database):
    with database.begin() as db:
        with pytest.raises(ValueError, match="来源"):
            create(db, "wrong", config(source="oanda"), at=0)
        ident = create(db, "expires", config(expires_at=1000), at=0).id
        consume(db, ident, sample(0, 9), detected_at=0)
        assert consume(db, ident, sample(1, 11), detected_at=1000) is None
        assert db.get(ChartAlert, ident).status == "expired"


def lifecycle(db, alert_id, version, action, *, at=None):
    import uuid
    return apply_lifecycle(db, alert_id, version, action,
                           expected_revision=db.get(ChartAlert, alert_id).control_revision,
                           request_id=uuid.uuid4().hex, at=at)


def test_lifecycle_fences_delayed_actions_and_replays_restart_once(database):
    with database.begin() as db:
        row = create(db, "lifecycle-race", config(), at=0)
        apply_lifecycle(db, row.id, 1, "pause", expected_revision=1, request_id="pause", at=100)
        apply_lifecycle(db, row.id, 1, "resume", expected_revision=2, request_id="resume", at=200)
        with pytest.raises(Conflict):
            apply_lifecycle(db, row.id, 1, "pause", expected_revision=1, request_id="delayed", at=300)
        # Retrying the original pause is a no-op, and cannot undo the resume.
        apply_lifecycle(db, row.id, 1, "pause", expected_revision=1, request_id="pause", at=300)
        assert row.status == "active" and row.control_revision == 3
        apply_lifecycle(db, row.id, 1, "restart", expected_revision=3, request_id="restart", at=400)
        consume(db, row.id, sample(1, 9), detected_at=400)
        consume(db, row.id, sample(2, 11), detected_at=600_001)
        assert row.count == 1
        apply_lifecycle(db, row.id, 1, "restart", expected_revision=3, request_id="restart", at=500)
        assert row.run == 2 and row.count == 1 and row.control_revision == 4
        with pytest.raises(Conflict):
            apply_lifecycle(db, row.id, 1, "pause", expected_revision=4, request_id="restart")
