"""Summary parity, bounded SQL, and explicit membership positions for refresh."""

from alerts.data_center import dataset_detail, dataset_list
from alerts.dataset_summaries import summaries
from alerts.history_artifacts import artifact_tick
from alerts.history_maintenance import configure, create_run
from alerts.history_versions import import_page
from alerts.storage import DatasetMaintenance
from sqlalchemy import event
from test_history_maintenance import Adapter
from test_market_contracts import identity
from test_market_datasets import register


def seed(db, code):
    register(db, identity(provider_symbol=code), logical_symbol=code)
    configure(db, identity(provider_symbol=code).key, target_start=0, timeframes=["M1", "H4"])


def test_rows_batch_without_per_item_detail_and_preserve_period_versions(database):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        parent = create_run(db, identity().key, end=120000, request_id="first").id
    import_page(Adapter(), version_id=parent)
    while artifact_tick(parent):
        pass
    with database.begin() as db:
        row = summaries(db)["items"][0]
        full = dataset_detail(db, identity().key)
        for key in ("id", "identity", "availability", "latest_version_id", "usable_timeframes", "available_start", "available_end"):
            assert row[key] == full[key]
        assert {p["timeframe"]: p["available_version_id"] for p in row["periods"]} == {
            p["timeframe"]: p["available_version_id"] for p in full["periods"]}


def test_query_count_is_bounded_and_full_api_stays_compatible(database):
    with database.begin() as db:
        for number in range(30):
            seed(db, f"S{number:03}")
    queries = []
    engine = database.kw["bind"]
    def observed(*args):
        queries.append(args[2])
    event.listen(engine, "before_cursor_execute", observed)
    try:
        with database() as db:
            old = dataset_list(db, page_size=25)
        old_count = len(queries)
        queries.clear()
        with database() as db:
            one = summaries(db, page_size=1)
        one_count = len(queries)
        queries.clear()
        with database() as db:
            page = summaries(db, page_size=25)
        count = len(queries)
        assert old["total"] == one["total"] == page["total"] == 30
        assert [row["id"] for row in old["items"]] == [row["id"] for row in page["items"]]
        assert count <= one_count + 1 and count < old_count / 3
        assert [row["position"] for row in page["items"]] == list(range(1, 26))
        print(f"summary SQL: 1 row={one_count}, 25 rows={count}, legacy 25 rows={old_count}")
    finally:
        event.remove(engine, "before_cursor_execute", observed)


def test_batch_reports_removed_members_and_rank_changes(database):
    with database.begin() as db:
        for code in ("BBB", "DDD"):
            seed(db, code)
        initial = summaries(db)["items"]
        selected = ",".join(row["id"] for row in initial)
        seed(db, "AAA")
        shifted = summaries(db, ids=selected)
        assert [row["position"] for row in shifted["items"]] == [2, 3]
        assert shifted["total"] == 3
        assert summaries(db, anchor="dataset-" + initial[1]["id"])["anchor_position"] == 3
        assert summaries(db, query="AAA", anchor="dataset-" + initial[1]["id"])["anchor_position"] is None
        db.get(DatasetMaintenance, identity(provider_symbol="BBB").key).archived = True
        db.flush()
        removed = summaries(db, ids=selected)
        assert len(removed["items"]) == 1
        assert removed["items"][0]["logical_symbol"] == "DDD"
        assert removed["items"][0]["position"] == 2


def test_summary_api_validates_batch_and_preserves_full_endpoint(database):
    from alerts import api
    from fastapi.testclient import TestClient

    with database.begin() as db:
        seed(db, "API")
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            base = "/api/market-data/center/"
            summary = client.get(base + "dataset-summaries")
            assert summary.status_code == 200 and summary.json()["total"] == 1
            assert client.get(base + "dataset-summaries?ids=invalid").status_code == 422
            assert client.get(base + "dataset-summaries?page_size=101").status_code == 422
            assert client.get(base + "dataset-summaries?view=invalid").status_code == 422
            assert client.get(base + "dataset-summaries?anchor=invalid").status_code == 422
            full = client.get(base + "datasets").json()["items"][0]
            assert "input_timeframes" in full and "maintenance" in full
            assert client.get(base + "platform-revision").status_code == 200
    finally:
        api.app.dependency_overrides.clear()


def test_selected_continuation_health_is_batched_and_old_errors_do_not_taint_it(database, monkeypatch):
    from alerts.composite_definitions import save_mapping
    from alerts.managed_continuation import configure as continuation
    from alerts.managed_continuation import report
    from alerts.storage import CompositePreparation
    from test_composite_definitions import PROOF, prepare, publish

    catalog = prepare(database, monkeypatch)
    publish(database)
    with database.begin() as db:
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        first = save_mapping(db, identity().key, catalog, PROOF)
        original = continuation(db, identity().key, value=True, mapping_id=first.id)
        db.get(CompositePreparation, original["composite"]["active_revision_id"]).error = "old configuration error"
        second = save_mapping(db, identity().key, catalog, {**PROOF, "rationale": "An independent product mapping selected after the earlier configuration"})
        selected = continuation(db, identity().key, value=True, mapping_id=second.id)
        prep = db.get(CompositePreparation, selected["composite"]["active_revision_id"])
        db.flush()
        assert summaries(db)["items"][0]["continuation"]["status"] == "preparing"
        prep.status = "queried"
        db.flush()
        for session in ("scheduled_open", "closed"):
            monkeypatch.setattr("alerts.composite_quotes.session_status", lambda *_: {"market_session": session,
                "next_session_at": None, "calendar_verified": True})
            assert summaries(db)["items"][0]["continuation"]["status"] == report(db, identity().key)["status"]
        prep.error = "selected configuration error"
        db.flush()
        assert summaries(db)["items"][0]["continuation"]["status"] == "attention"
        continuation(db, identity().key, value=False)
        db.delete(db.get(CompositePreparation, original["composite"]["active_revision_id"]))
        db.flush()
        summary = summaries(db)["items"][0]["continuation"]
        assert summary["status"] == "disabled"
        assert set(summary["composite_ids"]) == {original["composite"]["id"], selected["composite"]["id"]}
        assert summaries(db, anchor="composite-" + original["composite"]["id"])["anchor_position"] == 1


def test_active_calendar_revision_outside_page_retains_its_mapping_and_switch(database, monkeypatch):
    from alerts.managed_continuation import report
    from alerts.realtime_switch import set_enabled
    from alerts.storage import CompositeRevision, HistoryVersion, MarketComposite, MarketDataset
    from sqlalchemy import select
    from test_composite_revisions import (
        test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity,
    )

    test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity(database, monkeypatch)
    with database.begin() as db:
        composite = db.scalar(select(MarketComposite))
        original = db.get(MarketDataset, composite.dataset_id)
        active = db.get(CompositeRevision, composite.active_revision_id)
        destination = db.get(MarketDataset, db.get(HistoryVersion, active.history_version_id).dataset_id)
        assert original.id != destination.id
        configure(db, original.id, target_start=0, timeframes=["M1"])
        set_enabled(db, original.instrument_id, True, now=200010000)
        for choice in (False, True):
            set_enabled(db, destination.instrument_id, choice, now=200010000)
            # The destination is not in this batch/page, yet determines the
            # active revision's live readiness just as it does for old charts.
            row = summaries(db, ids=original.id)["items"][0]
            expected = report(db, original.id)
            assert row["continuation"]["status"] == expected["status"]
            assert row["continuation"]["status"] != "attention"


def test_legacy_continuation_without_maintenance_is_listed_without_creating_plan(database, monkeypatch):
    from alerts.composite_definitions import save_mapping
    from alerts.managed_continuation import configure as continuation
    from alerts.storage import MarketDataset
    from sqlalchemy import func, select
    from test_composite_definitions import PROOF, prepare, publish

    catalog = prepare(database, monkeypatch)
    publish(database)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        saved = continuation(db, identity().key, value=True, mapping_id=mapping.id)
        assert db.scalar(select(func.count()).select_from(MarketDataset)) > 1
        assert db.scalar(select(func.count()).select_from(DatasetMaintenance)) == 0
        assert dataset_list(db)["total"] == 0  # Existing full endpoint remains compatible.
        response = summaries(db, view="continuation", anchor="composite-" + saved["composite"]["id"])
        assert response["total"] == response["anchor_position"] == 1
        row = response["items"][0]
        assert row["id"] == identity().key and row["usable_timeframes"]
        assert row["maintenance"]["configured"] is False
        assert row["maintenance"]["archived"] is False
        assert row["continuation"]["enabled"] is True
        assert row["continuation"]["composite_ids"] == [saved["composite"]["id"]]
        assert summaries(db, status="archived")["total"] == 0
        assert summaries(db, status="paused")["total"] == 0
        assert db.scalar(select(func.count()).select_from(DatasetMaintenance)) == 0
