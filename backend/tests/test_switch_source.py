"""Source capability boundary: fixture sources, drift and rejected candidates."""

from dataclasses import replace

import pytest
import test_composite_revisions as contracts
from alerts import switch_source
from alerts.composite_revisions import create
from alerts.history_catalog import account_scope
from alerts.storage import CompositeRevision, RealtimeMapping


def test_two_fixture_sources_have_independent_identity_and_switch_safely():
    report = switch_source.fixture_switch()
    assert report["compatible"] and report["switch"] and report["fixture"]
    assert report["previous"]["identity"] != report["candidate"]["identity"]
    assert (report["previous"]["source"], report["candidate"]["source"]) == (
        "fixture-primary", "fixture-standby")
    assert {check["field"] for check in report["checks"]} == {
        "account_scope", "environment", "instrument", "basis", "confirmation",
        "precision", "freshness_ms"}
    assert all(check["ok"] for check in report["checks"])
    assert report["labelled"].startswith("fixture sources")
    # Re-running cannot move either fixture: the boundary is read-only.
    assert (switch_source.fixture("fixture-primary").record()
            == report["previous"] and switch_source.fixture("fixture-standby").record()
            == report["candidate"])


def test_incompatible_fixture_is_rejected_on_every_differing_capability():
    with pytest.raises(switch_source.SourceIncompatible) as caught:
        switch_source.fixture_switch(candidate="fixture-incompatible")
    report = caught.value.report
    assert not report["compatible"]
    assert [failure["field"] for failure in report["failures"]] == [
        "basis", "precision", "freshness_ms"]
    assert report["reasons"] == ["价格口径不一致：当前 bid，候选 ask",
                                 "精度不一致：当前 5，候选 3",
                                 "新鲜度不一致：当前 5000，候选 60000"]
    # The safe half: the running capability and its identity are untouched.
    assert switch_source.fixture("fixture-primary").record() == report["previous"]


def test_account_scope_and_freshness_are_checked_against_the_running_account():
    running = switch_source.fixture("fixture-primary", account="sha256:" + "a" * 64)
    elsewhere = switch_source.fixture("fixture-standby", account="sha256:" + "b" * 64)
    stale = replace(switch_source.fixture("fixture-primary", account="sha256:" + "a" * 64),
                    freshness_ms=None)
    with pytest.raises(switch_source.SourceIncompatible, match="账户范围") as caught:
        switch_source.validate(running, elsewhere, account="sha256:" + "a" * 64)
    assert [item["field"] for item in caught.value.report["failures"]] == ["account_scope"]
    with pytest.raises(switch_source.SourceIncompatible, match="新鲜度"):
        switch_source.validate(running, stale, account="sha256:" + "a" * 64)


def test_capabilities_read_the_running_revision_without_a_request(database, monkeypatch):
    composite, old, body = contracts.request(database, monkeypatch)
    with database.begin() as db:
        ident = create(db, composite, body).id
        previous = switch_source.capabilities(db, db.get(CompositeRevision, old))
        candidate = switch_source.capabilities(db, db.get(CompositeRevision, ident))
        assert previous.account_scope == account_scope()
        assert (previous.source, previous.channel, previous.environment) == (
            "oanda", "v20", "practice")
        assert (previous.instrument, previous.basis) == ("EURUSD", "bid")
        assert previous.precision == 5 and previous.confirmation == "confirmed_minutes"
        assert previous.freshness_ms == switch_source.DELIVERY_MS[("oanda", "v20")]
        assert previous.identity == db.get(RealtimeMapping,
            db.get(CompositeRevision, old).mapping_id).target_dataset_id
        report = switch_source.check(db, db.get(CompositeRevision, old),
                                     db.get(CompositeRevision, ident))
        assert report["compatible"] and not report["switch"]
        assert report["previous"] == previous.record()
        assert candidate.identity == previous.identity  # same live source dataset
