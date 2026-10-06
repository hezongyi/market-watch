"""Fixed bounded catch-up, lease recovery and honest empty-query evidence."""

import pytest
from alerts import composite_preparation as worker
from alerts.composite_definitions import first_use, save_mapping
from alerts.composite_inputs import rows
from alerts.storage import (
    CompositeInputEvent,
    CompositePreparation,
    CompositeReadAttempt,
    CompositeRevision,
    SourceMinuteRevision,
)
from sqlalchemy import func, select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import batch, identity, minute


def ready(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    publish(database)
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: 165725000)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        return composite.active_revision_id


def answer(ownership, **changes):
    start, end = ownership["start"], ownership["end"]
    return batch(**{"identity": ownership["identity"], "window_start": start, "window_end": end,
        "checkpoint": end, "observed_at": 165725000,
        "rows": (minute(start, volume="3"), minute(start + 60000, volume="4")),
        "volume_kind": "price_count", "volume_unit": "quotes", **changes})


def test_fixed_tail_checkpoint_and_minute_input_are_independent(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    owned = worker.claim(revision_id)
    worker.commit(owned, answer(owned, rows=(minute(owned["start"], volume="3"),)))
    assert worker.claim(revision_id) is None
    with database.begin() as db:
        prep = db.get(CompositePreparation, revision_id)
        assert prep.status == "queried" and prep.cursor == prep.cutoff == 165720000
        assert prep.confirmed_end == 165660000 and prep.input_revision == 1
        assert prep.state["query_complete"] and "unknown" in prep.state["coverage"]
        assert db.get(CompositeRevision, revision_id).activated_at is None
        attempt = db.scalar(select(CompositeReadAttempt))
        assert attempt.accepted and attempt.observations == 1 and attempt.id != owned["token"]
        assert len(list(rows(db, revision_id, owned["start"], owned["end"]))) == 1


def test_empty_success_finishes_query_without_confirming_any_prices(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    owned = worker.claim(revision_id)
    worker.commit(owned, answer(owned, rows=(), result={"status": "empty_success"}))
    with database.begin() as db:
        prep = db.get(CompositePreparation, revision_id)
        assert prep.status == "queried" and prep.confirmed_end == 0 and prep.input_revision == 0
        assert db.scalar(select(CompositeInputEvent)) is None
        assert db.scalar(select(CompositeReadAttempt)).result == "empty_success"


def test_lease_replacement_rejects_old_source_writes_and_preserves_interruption(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    old = worker.claim(revision_id)
    with database.begin() as db:
        db.get(CompositePreparation, revision_id).lease_until = 0
    successor = worker.claim(revision_id)
    with pytest.raises(TimeoutError, match="ownership"):
        worker.commit(old, answer(old))
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(SourceMinuteRevision)) == 0
        assert db.scalar(select(CompositeInputEvent)) is None
        previous = db.get(CompositeReadAttempt, worker.read_id(old["token"]))
        assert previous.result == "interrupted" and not previous.accepted
    worker.commit(successor, answer(successor))
    with database.begin() as db:
        assert db.get(CompositePreparation, revision_id).input_revision == 1


def test_failed_reads_retry_without_losing_the_failure_denominator(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    class Adapter:
        def __init__(self):
            self.calls = 0
        def page(self, source, start, end):
            self.calls += 1
            owned = {"identity": source, "start": start, "end": end}
            return answer(owned, rows=(), result={"status": "rate_limited", "retry_at": 0}) if self.calls == 1 else answer(owned)
    adapter = Adapter()
    assert worker.preparation_tick(adapter, revision_id)
    with database.begin() as db:
        prep = db.get(CompositePreparation, revision_id)
        assert prep.status == "retrying" and prep.cursor == 165600000
        assert db.scalar(select(CompositeReadAttempt)).result == "rate_limited"
        prep.next_at = 0
    assert worker.preparation_tick(adapter, revision_id)
    with database.begin() as db:
        attempts = list(db.scalars(select(CompositeReadAttempt).order_by(CompositeReadAttempt.started_at)))
        assert len(attempts) == 2 and sum(row.accepted for row in attempts) == 1
        assert db.get(CompositePreparation, revision_id).status == "queried"


def test_source_cache_can_prepare_another_revision_without_fabricating_live_read(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    from alerts.source_history_store import shared_page
    class Adapter:
        def page(self, source, start, end):
            return answer({"identity": source, "start": start, "end": end})
    owned = worker.claim(revision_id)
    cached = shared_page(Adapter(), identity=__import__("alerts.market_contracts", fromlist=["DatasetIdentity"]).DatasetIdentity.model_validate(owned["identity"]),
        start=owned["start"], end=owned["end"], fresh_after=owned["fresh_after"])
    class Forbidden:
        def page(self, *args):
            raise AssertionError("Cache should satisfy this bounded query")
    with database.begin() as db:
        db.get(CompositePreparation, revision_id).lease_until = 0
    assert worker.preparation_tick(Forbidden(), revision_id)
    with database.begin() as db:
        attempt = db.scalar(select(CompositeReadAttempt).where(CompositeReadAttempt.accepted))
        assert attempt.read_kind == "shared_cache" and attempt.observed_at == cached.observed_at
