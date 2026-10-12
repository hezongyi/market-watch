"""Audit timestamps describe review actions, never applicability intervals."""
import json
import sys
from datetime import UTC, datetime, timedelta

import pytest
from alerts import api, calendar_admin
from alerts.calendar_profile import normalized_profile
from alerts.market_calendar import calendar_rows
from alerts.market_datasets import register_dataset
from alerts.storage import Audit, Instrument
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_market_datasets import identity
from test_source_calendar import profile


def fixture(db, revision="reviewed-fixture-v1"):
    ident = identity(calendar_version=revision)
    return register_dataset(db, ident, logical_symbol="EURUSD", label="fixture", calendar="ny17",
                            precision=5, volume_kind="quantity", volume_unit="source_quantity",
                            calendar_profile=profile(ident))


def row(db, instrument, *, as_of=datetime(2026, 7, 6, tzinfo=UTC)):
    return next(r for r in calendar_rows(db=db, as_of=as_of)
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


def test_review_deadline_is_evaluated_at_read_time_and_renewed_by_latest_audit(database, monkeypatch):
    monkeypatch.setattr(calendar_admin, "now_ms", lambda: 1788220800000)
    with database.begin() as db:
        inst = fixture(db)
        original = inst.calendar_profile.copy()
        calendar_admin.record_review(db, inst.id, revision="reviewed-fixture-v1",
            reviewer="fixture", method="comparison", evidence_version="fixture-v1",
            review_due_at="2026-10-01")
    with database() as db:
        for moment, expected in (
            (datetime(2026, 10, 1, 23, 59, tzinfo=UTC), "verified"),
            (datetime(2026, 10, 2, tzinfo=UTC), "review_due"),
            (datetime(2026, 10, 12, tzinfo=UTC), "review_due"),
        ):
            actual = row(db, inst.id, as_of=moment)
            assert actual["status"] == expected
            assert actual["calendar_verified"] is True
            assert actual["market_session"] == "scheduled_open"
    monkeypatch.setattr(calendar_admin, "now_ms", lambda: 1791763200000)
    with database.begin() as db:
        review(db, inst.id)
    with database() as db:
        for moment, expected in (
            (datetime(2026, 10, 12, tzinfo=UTC), "verified"),
            (datetime(2026, 11, 1, 23, 59, tzinfo=UTC), "verified"),
            (datetime(2026, 11, 2, tzinfo=UTC), "review_due"),
        ):
            actual = row(db, inst.id, as_of=moment)
            assert actual["review_due_at"] == "2026-11-01"
            assert actual["status"] == expected
            assert actual["calendar_verified"] is True
        assert db.get(Instrument, inst.id).calendar_profile == original


@pytest.mark.parametrize("moment", [
    datetime(2025, 12, 31, 23, 59, tzinfo=UTC),
    datetime(2026, 7, 10, 20, 59, tzinfo=UTC),
    datetime(2027, 1, 1, tzinfo=UTC),
])
def test_review_cannot_certify_out_of_scope_or_boundary_minutes(database, moment):
    with database.begin() as db:
        inst = fixture(db)
        before = row(db, inst.id, as_of=moment)
        assert before["status"] == "unverified"
        review(db, inst.id)
    with database() as db:
        after = row(db, inst.id, as_of=moment)
        assert after["status"] == before["status"]
        assert after["market_session"] == "unknown"
        assert after["calendar_verified"] is False
        assert after["valid_from"] == before["valid_from"]
        assert after["valid_until"] == before["valid_until"]


def test_calendar_api_counts_overdue_reviews_and_latest_renewal(database, monkeypatch):
    moment = datetime.now(UTC).replace(second=0, microsecond=0)
    ident = identity(calendar_version="api-review-fixture-v1")
    proposed = profile(ident)
    proposed["source_session"].update(
        reviewed_start=(moment - timedelta(days=366)).isoformat(),
        reviewed_end=(moment + timedelta(days=366)).isoformat(), weekly_closures=[])
    with database.begin() as db:
        inst = register_dataset(db, ident, logical_symbol="EURUSD", label="fixture", calendar="ny17",
            precision=5, volume_kind="quantity", volume_unit="source_quantity", calendar_profile=proposed)
    monkeypatch.setitem(api.app.dependency_overrides, api.authenticated, lambda: "test")

    with TestClient(api.app) as client:
        def fetch(expected_status, expected_count):
            response = client.get("/api/market-data/center/calendars?source=dukascopy&query=EURUSD")
            assert response.status_code == 200
            payload = response.json()
            actual = next(r for r in payload["items"] if inst.id in r.get("row_id", ""))
            assert actual["status"] == expected_status
            if expected_count is not None:
                assert payload["review_due"] == expected_count
            return payload["review_due"]

        baseline = fetch("verified", None)
        for days, status, count in ((-1, "review_due", baseline + 1), (1, "verified", baseline)):
            monkeypatch.setattr(calendar_admin, "now_ms", lambda: int(moment.timestamp() * 1000) + days)
            with database.begin() as db:
                calendar_admin.record_review(db, inst.id, revision=ident.calendar_version,
                    reviewer="fixture", method="comparison", evidence_version="fixture-v1",
                    review_due_at=(moment + timedelta(days=days)).date().isoformat())
            fetch(status, count)


@pytest.mark.parametrize("apply", [False, True])
@pytest.mark.parametrize("contents", ["{}", "null", "[]", "false", "0"])
def test_cli_rejects_empty_or_nonobject_profile_without_success_or_writes(
        database, monkeypatch, tmp_path, capsys, apply, contents):
    path = tmp_path / "invalid-profile.json"
    path.write_text(contents)
    arguments = ["calendar_admin", "--instrument", "EURUSD", "--file", str(path)]
    if apply:
        arguments.append("--apply")
    monkeypatch.setattr(sys, "argv", arguments)
    with pytest.raises(ValueError):
        calendar_admin.main()
    assert capsys.readouterr().out == ""
    with database() as db:
        assert db.get(Instrument, "EURUSD").calendar_profile == {}
        assert db.scalar(select(Audit).where(Audit.kind.in_(
            ("calendar_profile_changed", "calendar_review")))) is None


def test_cli_applies_profile_and_commits_review_for_the_same_revision(database, monkeypatch, tmp_path, capsys):
    path = tmp_path / "profile.json"
    proposed = {"revision": "legacy-fixture-v1", "closures": []}
    path.write_text(json.dumps(proposed))
    monkeypatch.setattr(sys, "argv", ["calendar_admin", "--instrument", "EURUSD",
        "--file", str(path), "--apply", "--reviewer", "fixture", "--review-method", "comparison",
        "--evidence-version", "fixture-v1", "--review-due", "2026-11-01"])
    calendar_admin.main()
    assert json.loads(capsys.readouterr().out)["applied"] is True
    with database() as db:
        assert db.get(Instrument, "EURUSD").calendar_profile == proposed
        event = db.scalar(select(Audit).where(Audit.kind == "calendar_review"))
        assert event.details["revision"] == proposed["revision"]
