"""Failures survive successful retries and never alter final coverage denominators."""

import json

import pytest
from alerts import history_versions as history
from alerts.data_center import coverage_report
from alerts.history_request_evidence import attempt_id, report, snapshot
from alerts.market_contracts import RequestResult
from alerts.storage import HistoryReadAttempt, HistoryVersion
from sqlalchemy import select
from test_history_versions import Adapter, create
from test_market_contracts import batch


def test_failed_request_survives_retry_and_success_has_no_failed_missing_minutes(database):
    ident, _ = create(database)
    history.import_page(Adapter([batch(rows=(), result=RequestResult(status="timeout"), checkpoint=0)]), version_id=ident)
    with database.begin() as db:
        failed = report(db, ident)
        assert failed["total"] == failed["failed"] == 1
        assert failed["items"][0]["result"] == "timeout"
        assert failed["items"][0]["read_kind"] == "supplier_request"
        assert not failed["items"][0]["accepted"]
        assert db.get(HistoryVersion, ident).cursor == 0
        db.get(HistoryVersion, ident).next_at = 0
    history.import_page(Adapter([batch(checkpoint=120000)]), version_id=ident)
    with database.begin() as db:
        result = report(db, ident)
        assert result["total"] == 2 and result["failed"] == 1
        assert {row["result"] for row in result["items"]} == {"data", "timeout"}
        assert coverage_report(db, ident)["items"][0]["unknown_minutes"] == 0
        assert snapshot(db, ident) == db.get(HistoryVersion, ident).manifest["request_evidence"]
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            attempt = db.scalar(select(HistoryReadAttempt).where(HistoryReadAttempt.version_id == ident,
                                                                 HistoryReadAttempt.result == "timeout"))
            attempt.result = "data"
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            attempt = db.scalar(select(HistoryReadAttempt).where(HistoryReadAttempt.version_id == ident))
            attempt.finished_at = None


def test_direct_timeout_and_private_exception_text_are_safe(database):
    ident, _ = create(database)
    class Timeout:
        def page(self, *args):
            raise TimeoutError("private-account-and-token-do-not-store")
    history.import_page(Timeout(), version_id=ident)
    with database.begin() as db:
        result = report(db, ident)
        assert result["items"][0]["result"] == "timeout"
        assert db.get(HistoryVersion, ident).error == "timeout"
        assert "private" not in json.dumps(result)


def test_crash_recovery_marks_unknown_outcome_and_fences_late_reader(database):
    ident, _ = create(database)
    first = history.claim(ident)
    with database.begin() as db:
        assert report(db, ident)["items"][0]["result"] == "started"
        db.get(HistoryVersion, ident).lease_until = 0
    second = history.claim(ident)
    assert first[1] != second[1]
    with database.begin() as db:
        old = db.get(HistoryReadAttempt, attempt_id(first[1]))
        assert old.result == "interrupted" and not old.accepted
        from alerts.history_request_evidence import finish
        finish(old, "data", accepted=True)
        assert old.result == "interrupted"
        assert report(db, ident)["failed"] == 0
        assert first[1] not in json.dumps(report(db, ident))


def test_read_evidence_survives_price_reclamation_and_does_not_block_it(database):
    from alerts.history_retention import reclaim
    from test_history_retention import prepared
    from test_market_contracts import identity

    ident, _ = prepared(database)
    with database.begin() as db:
        before = report(db, ident)
        assert before["total"] > 0
        reclaim(db, identity().key, "retain-request-evidence")
        assert report(db, ident) == before
    with pytest.raises(ValueError, match="cannot be deleted"):
        with database.begin() as db:
            db.delete(db.get(HistoryReadAttempt, before["items"][0]["id"]))
