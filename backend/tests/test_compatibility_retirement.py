"""Retired independent replicas cannot wake or publish stale candles."""

import pytest
from alerts.chart_aggregation import enqueue_aggregation
from alerts.storage import (
    Bar,
    ChartAggregationJob,
    ChartPublicationJob,
    ChartPublicationState,
    CompositeRevision,
    Instrument,
    MarketDataset,
    MarketDemand,
    RealtimeMapping,
)
from sqlalchemy import func, select
from test_composite_chart import populated


def setup_target(database, monkeypatch):
    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(
            MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id
        )
        ident = target.instrument_id
        from alerts.realtime_switch import set_enabled

        set_enabled(db, ident, False, now=200000000)
        db.add(
            Bar(
                instrument_id=ident,
                timeframe="M1",
                start=seam,
                end=seam + 60000,
                open=1,
                high=2,
                low=1,
                close=2,
                complete=True,
            )
        )
        enqueue_aggregation(db, ident, seam, seam + 60000, 200000000)
    return ident, composite, revision_id, seam


def test_retirement_clears_only_tasks_and_cannot_be_woken_by_old_chart(database, monkeypatch):
    from alerts.chart_query import DataQuery, data_sync
    from alerts.compatibility_retirement import retire
    from alerts.query_errors import QueryError

    ident, composite, revision, seam = setup_target(database, monkeypatch)
    with database.begin() as db:
        old_bars = db.scalar(
            select(func.count()).select_from(Bar).where(Bar.instrument_id == ident)
        )
        result = retire(db, [ident], apply=True)
        assert result[0]["deleted"]["chart_aggregation_jobs"] == 5
    with pytest.raises(QueryError) as error:
        data_sync(DataQuery(instrument=ident, timeframe="M5", limit=10))
    assert error.value.status_code == 410 and error.value.detail["code"] == "SERIES_RETIRED"
    with database.begin() as db:
        assert (
            db.scalar(select(func.count()).select_from(Bar).where(Bar.instrument_id == ident))
            == old_bars
        )
        assert not db.scalar(select(MarketDemand.id).where(MarketDemand.instrument_id == ident))
        for kind in ["price", "volume", "observed"]:
            enqueue_aggregation(db, ident, seam, seam + 120000, 200001000, kind=kind)
        from alerts.publication_schedule import request

        request(db, ident, approved=True)
        for cls in [ChartAggregationJob, ChartPublicationJob, ChartPublicationState]:
            assert not db.scalar(select(cls.instrument_id).where(cls.instrument_id == ident))
        assert retire(db, [ident], apply=True)[0]["already_retired"]
    from alerts.composite_chart import chart_page

    with database() as db:
        assert chart_page(db, composite, "M1", count=20, now=200010000)["bars"]


def test_retirement_preserves_new_confirmed_input_and_avoids_inline_aggregation(
    database, monkeypatch
):
    from alerts.compatibility_retirement import retire
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    from alerts.market import ingest
    from alerts.market_contracts import DatasetIdentity
    from alerts.storage import CompositePreparation
    from test_market_contracts import batch, minute

    ident, composite, revision_id, seam = setup_target(database, monkeypatch)
    with database.begin() as db:
        retire(db, [ident], apply=True)
    # Both synchronous live confirmation and deferred historical import must skip
    # only the old replicas. Canonical source revisions and composite input advance.
    for deferred in [False, True]:
        at = seam + (10 + int(deferred)) * 60000
        with database.begin() as db:
            target = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == ident))
            source = batch(
                identity=DatasetIdentity.model_validate(target.identity),
                window_start=at,
                window_end=at + 60000,
                checkpoint=at + 60000,
                observed_at=at + 65000,
                volume_kind="price_count",
                volume_unit="quotes",
                rows=(minute(at, volume="3"),),
            )
            apply_minutes(db, record(db, source))
            ingest(
                db,
                db.get(Instrument, ident),
                source.ingestion_payload(),
                defer_aggregation=deferred,
            )
            assert db.get(CompositePreparation, revision_id).input_revision == 2 + int(deferred)
            assert db.scalar(
                select(Bar.id).where(
                    Bar.instrument_id == ident, Bar.timeframe == "M1", Bar.start == at
                )
            )
            assert not db.scalar(
                select(Bar.id).where(Bar.instrument_id == ident, Bar.timeframe == "M5")
            )
            assert not db.scalar(
                select(ChartAggregationJob.id).where(ChartAggregationJob.instrument_id == ident)
            )
            assert not db.scalar(
                select(ChartPublicationState.instrument_id).where(
                    ChartPublicationState.instrument_id == ident
                )
            )
    from alerts.composite_chart import chart_page

    with database() as db:
        assert chart_page(db, composite, "M1", count=1, now=200010000)["bars"][-1]["start"] == at


def test_retirement_refuses_independent_consumer_and_is_atomic(database, monkeypatch):
    from alerts.compatibility_retirement import retire, retired

    ident, _, _, _ = setup_target(database, monkeypatch)
    with database.begin() as db:
        db.add(MarketDemand(id="independent", instrument_id=ident, expires=9999999999999))
    with pytest.raises(ValueError, match="consumer"):
        with database.begin() as db:
            retire(db, [ident], apply=True)
    with database() as db:
        assert not retired(db, ident)
        assert db.scalar(
            select(ChartAggregationJob.id).where(ChartAggregationJob.instrument_id == ident)
        )


def test_retirement_preview_and_unrelated_aggregates_remain_unchanged(database, monkeypatch):
    from alerts.compatibility_retirement import retire, retired

    ident, _, _, seam = setup_target(database, monkeypatch)
    with database.begin() as db:
        report = retire(db, [ident])
        assert report[0]["deleted"]["chart_aggregation_jobs"] == 5
        assert not retired(db, ident)
        if db.get(Instrument, "EURUSD") is None:
            db.add(
                Instrument(
                    id="EURUSD",
                    label="EURUSD",
                    precision=5,
                    source="oanda",
                    symbol="EUR_USD",
                    basis="mid",
                    calendar="ny17",
                )
            )
            db.flush()
        enqueue_aggregation(db, "EURUSD", seam, seam + 60000, 200000000)
        retire(db, [ident], apply=True)
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChartAggregationJob)
                .where(ChartAggregationJob.instrument_id == "EURUSD")
            )
            == 5
        )
    with pytest.raises(ValueError, match="disabled mapped"):
        with database.begin() as db:
            retire(db, ["EURUSD"], apply=True)


@pytest.mark.parametrize(
    "model_name", ["AdvancedWorkspace", "ChartWorkspace", "AdvancedPreference"]
)
def test_saved_layout_prevents_retirement_and_cannot_be_recreated_afterward(
    database, monkeypatch, model_name
):
    from alerts import storage
    from alerts.compatibility_retirement import retire
    from alerts.history_retention import lock_reference_values

    ident, _, _, _ = setup_target(database, monkeypatch)
    model = getattr(storage, model_name)

    def layout():
        value = {"panels": [{"instrument": "MWP:" + ident}]}
        return model(
            **(
                {"id": "saved", "kind": "chart", "name": "saved", "content": value}
                if model_name == "AdvancedPreference"
                else {"name": "saved", "document": value}
            )
        )

    with database.begin() as db:
        row = layout()
        db.add(row)
    with pytest.raises(ValueError, match="Saved consumer"):
        with database.begin() as db:
            retire(db, [ident], apply=True)
    with database.begin() as db:
        db.delete(db.scalar(select(model)))
        db.flush()
        retire(db, [ident], apply=True)
    with pytest.raises(ValueError, match="退役"):
        with database.begin() as db:
            db.add(layout())
    with pytest.raises(ValueError, match="退役"):
        with database.begin() as db:
            lock_reference_values(db, {"instrument": ident})


def test_retired_legacy_mutations_and_demands_are_rejected(database, monkeypatch):
    from alerts.chart_history_plan import control_plan, update_demand
    from alerts.compatibility_retirement import retire
    from alerts.managed_dataset import join
    from alerts.query_errors import QueryError
    from alerts.realtime_switch import set_enabled
    from alerts.volume_jobs import create

    ident, _, _, seam = setup_target(database, monkeypatch)
    with database.begin() as db:
        retire(db, [ident], apply=True)
    operations = [
        lambda db: join(db, db.get(Instrument, ident), 0, 200000000),
        lambda db: control_plan(db, ident, "resume", 200000000),
        lambda db: set_enabled(db, ident, True, now=200000000),
        lambda db: create(db, ident, start=seam, end=seam + 60000),
        lambda db: db.add(MarketDemand(id="old", instrument_id=ident, expires=9999999999999)),
    ]
    for operation in operations:
        with pytest.raises(ValueError, match="退役"):
            with database.begin() as db:
                operation(db)
    with pytest.raises(QueryError) as error:
        with database.begin() as db:
            update_demand(
                db,
                ident="viewport",
                instrument=ident,
                timeframe="M5",
                end=seam + 60000,
                visible=100,
                focused=True,
                now=200000000,
            )
    assert error.value.status_code == 410


def test_retired_completed_alert_cannot_restart_but_keeps_history(database, monkeypatch):
    from alerts.chart_alert_service import lifecycle
    from alerts.compatibility_retirement import retire
    from alerts.storage import ChartAlert, ChartAlertVersion
    from test_chart_alert_service import config

    ident, _, _, _ = setup_target(database, monkeypatch)
    with database.begin() as db:
        alert = ChartAlert(
            request_id="completed-old",
            request_hash="hash",
            name="old",
            status="completed",
            effective_at=0,
        )
        db.add(alert)
        db.flush()
        alert_id, control = alert.id, alert.control_revision
        db.add(
            ChartAlertVersion(
                alert_id=alert_id,
                version=1,
                config=config(instrument=ident, source="oanda").model_dump(mode="json"),
                market_identity={"instrument": ident, "series_kind": "managed"},
                effective_at=0,
            )
        )
    with database.begin() as db:
        retire(db, [ident], apply=True)
    with pytest.raises(ValueError, match="退役"):
        with database.begin() as db:
            lifecycle(
                db,
                alert_id,
                1,
                "restart",
                expected_revision=control,
                request_id="restart",
                at=200000000,
            )
    with database.begin() as db:
        assert db.get(ChartAlert, alert_id).status == "completed"
        assert db.scalar(select(ChartAlertVersion).where(ChartAlertVersion.alert_id == alert_id))
        lifecycle(
            db,
            alert_id,
            1,
            "archive",
            expected_revision=control,
            request_id="archive",
            at=200000000,
        )
