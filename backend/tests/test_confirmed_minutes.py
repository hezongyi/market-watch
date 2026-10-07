"""Immutable minute audit, real freshness ordering and composite input pinning."""

import pytest
from alerts import confirmed_minutes as store
from alerts.composite_definitions import first_use, save_mapping
from alerts.composite_inputs import apply_minutes, rows
from alerts.storage import (
    CompositeInputEvent,
    CompositeMinute,
    CompositePreparation,
    CompositeRevision,
    SourceMinute,
    SourceMinuteRevision,
)
from sqlalchemy import func, select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import batch, identity, minute


def observation(stamp, **changes):
    return batch(**{"observed_at": stamp, "checkpoint": 120000, **changes})


def test_unchanged_newer_observation_prevents_late_price_rollback(database):
    with database.begin() as db:
        first = store.record(db, observation(100))
        same = store.record(db, observation(200, rows=(minute(open="1.1000"), minute(60000))))
        late = store.record(db, observation(150, rows=(minute(close="1.12"), minute(60000))))
        assert first["minutes"][0]["revision_id"] == same["minutes"][0]["revision_id"] == late["minutes"][0]["revision_id"]
        assert not same["minutes"][0]["changed"] and late["minutes"][0]["stale"]
        assert db.get(SourceMinute, (first["source_id"], 0)).last_observed_at == 200
        assert db.scalar(select(func.count()).select_from(SourceMinuteRevision)) == 2
        revised = store.record(db, observation(250, rows=(minute(close="1.12"), minute(60000))))
        assert revised["minutes"][0]["changed"] and not revised["minutes"][1]["changed"]
        assert db.get(SourceMinuteRevision, first["minutes"][0]["revision_id"]).data["close"] == "1.11"
        assert list(store.rows(db, first["source_id"], 0, 60000))[0]["close"] == "1.12"


def test_calendar_variants_share_heads_but_sources_do_not(database):
    with database.begin() as db:
        first = store.record(db, observation(100))
        second = store.record(db, observation(200, identity=identity(calendar_version="utc0-v1")))
        other = store.record(db, observation(200, identity=identity(provider_symbol="GBP/USD")))
        assert first["source_id"] == second["source_id"] != other["source_id"]
        assert first["minutes"][0]["revision_id"] == second["minutes"][0]["revision_id"]


@pytest.mark.parametrize("changes", [
    {"checkpoint": None}, {"checkpoint": 60000}, {"rows": (minute(complete=False),)},
    {"rows": (), "result": {"status": "timeout"}},
])
def test_invalid_confirmation_never_persists(database, changes):
    with database.begin() as db:
        with pytest.raises(ValueError, match="bounded"):
            store.record(db, observation(100, **changes))
        assert db.scalar(select(SourceMinuteRevision)) is None


@pytest.mark.parametrize("operation", ["update", "delete", "move"])
def test_audit_revision_and_head_identity_are_protected(database, operation):
    with database.begin() as db:
        result = store.record(db, observation(100))
        ident = result["minutes"][0]["revision_id"]
    with pytest.raises(ValueError, match="immutable|cannot be deleted"):
        with database.begin() as db:
            row = db.get(SourceMinuteRevision, ident)
            if operation == "update":
                row.data = {"close": "1.0"}
            elif operation == "delete":
                db.delete(row)
            else:
                db.get(SourceMinute, (result["source_id"], 0)).start = 180000


def test_composite_logs_changed_inputs_and_keeps_previous_price_evidence(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    publish(database)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        revision = db.get(CompositeRevision, composite.active_revision_id)
        seam = revision.seam
        from alerts.market_contracts import DatasetIdentity
        from alerts.storage import MarketDataset
        target = DatasetIdentity.model_validate(db.get(MarketDataset, mapping.target_dataset_id).identity)
        def tail(stamp, close="1.11"):
            return batch(identity=target, window_start=seam - 60000, window_end=seam + 120000,
                checkpoint=seam + 120000, observed_at=stamp, volume_kind="price_count", volume_unit="quotes",
                rows=(minute(seam - 60000, volume="2"), minute(seam, volume="2", close=close)))
        recorded = store.record(db, tail(100))
        applied = apply_minutes(db, recorded)
        assert applied[0]["changed_minutes"] == 1
        prep = db.get(CompositePreparation, revision.id)
        assert prep.input_revision == 1 and prep.confirmed_end == seam + 60000
        assert prep.cursor == seam  # Query checkpoint is independent of observed data.
        assert not apply_minutes(db, store.record(db, tail(200)))
        changed = apply_minutes(db, store.record(db, tail(250, close="1.12")))
        assert changed[0]["input_revision"] == 2
        events = list(db.scalars(select(CompositeInputEvent).order_by(CompositeInputEvent.input_revision)))
        before = events[0].input_manifest["minutes"][0]["source_revision_id"]
        after = events[1].input_manifest["minutes"][0]
        assert after["previous_source_revision_id"] == before
        assert db.get(SourceMinuteRevision, before).data["close"] == "1.11"
        assert db.get(CompositeMinute, (revision.id, seam)).source_revision_id == after["source_revision_id"]
        assert list(rows(db, revision.id, seam, seam + 60000, input_revision=1))[0]["close"] == "1.11"
        assert list(rows(db, revision.id, seam, seam + 60000, input_revision=2))[0]["close"] == "1.12"
        event_id = events[0].id
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(CompositeInputEvent, event_id).input_manifest = {}
