"""Audit timestamps describe review actions, never applicability intervals."""
from datetime import datetime, UTC
import sys

import pytest
from sqlalchemy import select

from alerts import calendar_admin
from alerts.calendar_profile import normalized_profile
from alerts.market_calendar import calendar_rows
from alerts.market_datasets import register_dataset
from alerts.storage import Audit, Instrument
from test_market_datasets import identity
from test_source_calendar import profile


def fixture(db, revision="reviewed-fixture-v1"):
    ident = identity(calendar_version=revision)
    return register_dataset(db, ident, logical_symbol="EURUSD", label="fixture", calendar="ny17",
                            precision=5, volume_kind="quantity", volume_unit="source_quantity",
                            calendar_profile=profile(ident))


def row(db, instrument):
    return next(r for r in calendar_rows(db=db, as_of=datetime(2026, 7, 6, tzinfo=UTC))
                if instrument in r.get("row_id", ""))


def review(db, instrument, revision="reviewed-fixture-v1"):
    return calendar_admin.record_review(db, instrument, revision=revision,
        reviewer="acceptance reviewer", method="source evidence comparison",
        evidence_version="fixture-evidence-v1", review_due_at="2026-11-01")


def test_unreviewed_applicability_has_no_audit_timestamp(database):
    with database.begin() as db:
        inst = fixture(db)
        actual = row(db, inst.id)
        assert actual["audit"] is None and actual["checked_at"] is None
        assert datetime.fromisoformat(actual["valid_from"]) == datetime(2026,1,1,tzinfo=UTC)
        assert actual["identity"]["price_basis"] == "bid"
        assert actual["identity"]["account_scope"] == "public"


def test_review_is_exact_identity_revision_and_latest_committed_action(database, monkeypatch):
    monkeypatch.setattr(calendar_admin, "now_ms", lambda: 1783300000000)
    with database.begin() as db:
        inst = fixture(db)
        other = fixture(db, "reviewed-fixture-v2")
        before = inst.calendar_profile.copy()
        event = review(db, inst.id)
        assert inst.calendar_profile == before
        assert event.at == 1783300000000
    with database() as db:
        actual = row(db, inst.id)
        assert actual["audit"]["reviewer"] == "acceptance reviewer"
        assert actual["checked_at"] == datetime.fromtimestamp(1783300000, UTC).isoformat()
        assert actual["checked_at"] != actual["valid_from"]
        assert row(db, other.id)["audit"] is None
    with database.begin() as db:
        with pytest.raises(ValueError, match="exact profile revision"):
            review(db, inst.id, "reviewed-fixture-v2")
    monkeypatch.setattr(calendar_admin, "now_ms", lambda: 1783300060000)
    with database.begin() as db:
        review(db, inst.id)
    with database() as db:
        assert row(db, inst.id)["checked_at"] == datetime.fromtimestamp(1783300060, UTC).isoformat()


def test_cli_can_record_explicit_dataset_review_without_mutating_calendar(database, monkeypatch, capsys):
    with database.begin() as db:
        inst = fixture(db)
    monkeypatch.setattr(sys, "argv", ["calendar_admin", "--instrument", inst.id,
        "--record-review", "reviewed-fixture-v1", "--apply", "--reviewer", "fixture",
        "--review-method", "comparison", "--evidence-version", "fixture-v1", "--review-due", "2026-11-01"])
    calendar_admin.main()
    assert '"review_recorded": true' in capsys.readouterr().out
    with database() as db:
        assert db.scalar(select(Audit).where(Audit.kind == "calendar_review"))
        assert db.get(Instrument, inst.id).calendar_profile == normalized_profile(profile(identity(calendar_version="reviewed-fixture-v1")))
