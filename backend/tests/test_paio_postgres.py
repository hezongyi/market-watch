"""Fixed PAIO workers use the shared test schema, never the development DB."""

import os

import pytest
from alerts import fixed_indicators as jobs
from alerts.chart_query import DataQuery, data_sync
from alerts.storage import FixedIndicatorRun
from test_fixed_indicators import history
from test_provider_postgres import provider_pg

__all__ = ["provider_pg"]


def fixed_restart(factory, monkeypatch, policy):
    version = history(factory, monkeypatch, count=160)
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.storage import HistoryVersion
    with factory.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, version), ["M15", "H1"])
    while artifact_tick(version):
        pass
    monkeypatch.setattr(jobs,"PAGE_SIZE",37)
    query=DataQuery(instrument=version,series_kind="history",timeframe="M1",limit=17,
        indicators=[dict(name="PAIO_V1")],indicator_input_policy=policy)
    pending=data_sync(query)
    ident=pending["indicator_progress"][0]["run_id"]
    for _ in range(100):
        if not jobs.indicator_tick(ident,raise_errors=True):
            break
    with factory.begin() as db:
        run=db.get(FixedIndicatorRun,ident)
        assert run.status=="complete",run.error
        assert run.state["state"]["index"]==159
        assert run.state["state"]["requests"]["ema_2"]["end"]==150*60000
        assert run.state["state"]["ma_2_last"] is not None
    latest=data_sync(query)
    assert not latest["pending"]
    assert latest["indicators"][0]["presentation"]["schema"]=="paio_presentation_v1"
    assert latest["indicators"][0]["presentation"]["readiness"]["ema_2"]
    older=data_sync(query.model_copy(update=dict(before=latest["bars"][0]["start"])))
    assert older["indicator_progress"][0]["run_id"]==ident
    assert older["indicators"][0]["presentation"]["objects"]==latest["indicators"][0]["presentation"]["objects"]


@pytest.mark.parametrize("policy",["strict_confirmed_v1","observed_display_v1"])
def test_fixed_paio_restart_sqlite(database,monkeypatch,policy):
    fixed_restart(database,monkeypatch,policy)


@pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),reason="Requires isolated Ubuntu PostgreSQL")
@pytest.mark.parametrize("policy",["strict_confirmed_v1","observed_display_v1"])
def test_fixed_paio_restart_postgres(provider_pg,monkeypatch,policy):
    fixed_restart(provider_pg[0],monkeypatch,policy)


def test_late_published_dependency_replaces_finished_missing_module_run(database,monkeypatch):
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.storage import HistoryVersion
    version = history(database,monkeypatch,count=160)
    query = DataQuery(instrument=version,series_kind="history",timeframe="M1",limit=17,indicators=[dict(name="PAIO_V1")])
    first = data_sync(query)["indicator_progress"][0]["run_id"]
    while jobs.indicator_tick(first,raise_errors=True):
        pass
    missing = data_sync(query)
    assert missing["indicators"][0]["presentation"]["readiness"]["ema_2"] is False
    assert missing["indicators"][0]["calculation"]["canonical_verified"] is False
    with database.begin() as db:
        request_artifacts(db,db.get(HistoryVersion,version),["M15","H1"])
    while artifact_tick(version):
        pass
    newer = data_sync(query)["indicator_progress"][0]["run_id"]
    assert newer != first
    while jobs.indicator_tick(newer,raise_errors=True):
        pass
    assert data_sync(query)["indicators"][0]["presentation"]["readiness"]["ema_2"] is True


def test_explicit_empty_replay_state_reads_from_origin_not_latest_request_cursor(database,monkeypatch):
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.indicator_state import IndicatorState
    from alerts.paio_inputs import attach_fixed, freeze_fixed, prepare_fixed
    from alerts.storage import HistoryVersion
    version=history(database,monkeypatch,count=160)
    with database.begin() as db:
        request_artifacts(db,db.get(HistoryVersion,version),["M15","H1"])
    while artifact_tick(version):
        pass
    query=DataQuery(instrument=version,series_kind="history",timeframe="M1",limit=160,indicators=[dict(name="PAIO_V1")])
    ident=data_sync(query)["indicator_progress"][0]["run_id"]
    while jobs.indicator_tick(ident,raise_errors=True):
        pass
    page=data_sync(query)
    with database.begin() as db:
        run=db.get(FixedIndicatorRun,ident)
        frozen=freeze_fixed(db,run,page["bars"],state={})
        assert frozen["frames"]["M15"]["rows"][0]["start"] == 0
        # The same initialization is used when checkpoint_before cannot find
        # a safe earlier checkpoint after a provisional correction.
        engine=IndicatorState(run.spec)
        prepared=attach_fixed(run,prepare_fixed(db,run,page["bars"],state=engine.state),
            "ny17",initial_state=engine.checkpoint())
        actual=[engine.step(row) for row in prepared]
        assert actual[-1]["ema_2"] == page["indicators"][0]["series"][11]["values"][-1]["value"]


def test_monthly_snapshot_dependency_reads_bounded_cross_month_partitions(database,monkeypatch):
    from datetime import datetime
    from types import SimpleNamespace

    from alerts.chart_indicators import validate
    from alerts.composite_chart import chart_page
    from alerts.composite_definitions import first_use, save_mapping
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    from alerts.display_snapshots import capture
    from alerts.history_artifacts import artifact_tick
    from alerts.history_versions import create_version, import_page
    from alerts.market_contracts import DatasetIdentity
    from alerts.paio_inputs import freeze_fixed
    from alerts.storage import CompositeRevision, HistoryVersion, MarketDataset
    from test_composite_definitions import PROOF, prepare
    from test_history_versions import Adapter
    from test_market_contracts import batch, identity, minute
    def at(value):
        return int(datetime.fromisoformat(value+"+00:00").timestamp()*1000)
    start,end,stamp=at("2026-11-01T00:00:00"),at("2026-11-29T22:00:00"),at("2026-12-24T16:01:00")
    catalog=prepare(database,monkeypatch)
    monkeypatch.setattr("alerts.live_window.now_ms",lambda:stamp)
    monkeypatch.setattr("alerts.history_versions.now_ms",lambda:stamp)
    monkeypatch.setattr("alerts.composite_definitions.now_ms",lambda:end+1000)
    with database.begin() as db:
        version=create_version(db,identity().key,start,end)
    import_page(Adapter([batch(window_start=start,window_end=end,checkpoint=end,rows=(minute(start),minute(end-60000)))]),version_id=version)
    while artifact_tick(version):
        pass
    with database.begin() as db:
        mapping=save_mapping(db,identity().key,catalog,PROOF)
        composite=first_use(db,identity().key,mapping.id)
        revision=db.get(CompositeRevision,composite.active_revision_id)
        assert revision.seam==end
        composite_id, revision_id, target_id = composite.id, revision.id, mapping.target_dataset_id
    while artifact_tick(version):
        pass
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target=db.get(MarketDataset,target_id)
        source=DatasetIdentity.model_validate(target.identity)
        for offset in (0, stamp-end-60000):
            left=end+offset
            apply_minutes(db,record(db,batch(identity=source,window_start=left,window_end=left+60000,
                checkpoint=left+60000,observed_at=stamp,volume_kind="price_count",volume_unit="quotes",rows=(minute(left,volume="3"),))))
        snapshot=capture(db,revision,"M1",stamp)
        page=chart_page(db,composite_id,"M1",count=2,revision_id=revision.id,now=stamp,provisional=True,display_snapshot=snapshot)
        run=SimpleNamespace(spec=dict(name="PAIO_V1", params=validate(dict(name="PAIO_V1",params=dict(ma_2_timeframe="1M",ma_3_timeframe="Chart")))[1]),
            timeframe="M1",revision_id=revision.id,input_revision=snapshot.input_revision,target_end=stamp,state={})
        monkeypatch.setattr(jobs,"_context",lambda *_:(db.get(HistoryVersion,version),revision,"ny17",[]))
        frozen=freeze_fixed(db,run,page["bars"],state={},stamp=stamp,snapshot=snapshot)
        rows=frozen["frames"]["MN"]["rows"]
        assert len(rows)==2
        assert len({row["start"] for row in rows})==2
        assert rows[0]["start"] < end < rows[1]["start"] < stamp


@pytest.mark.parametrize("policy",["strict_confirmed_v1","observed_display_v1"])
def test_foreground_mixed_specs_freeze_independent_full_paio_dependencies(database,monkeypatch,policy):
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.storage import HistoryVersion
    version=history(database,monkeypatch,count=300)
    with database.begin() as db:
        request_artifacts(db,db.get(HistoryVersion,version),["M15","H1"])
    while artifact_tick(version):
        pass
    monkeypatch.setattr(jobs,"PAGE_SIZE",37)
    specs=[dict(name="EMA",params=dict(period=2)),dict(id="paio1",name="PAIO_V1"),
        dict(id="paio2",name="PAIO_V1",params=dict(ma_2_timeframe="60",ma_2_length=3))]
    query=DataQuery(instrument=version,series_kind="history",timeframe="M1",limit=20,
        indicators=specs,client="paio-mixed-test",indicator_input_policy=policy,
        indicator_consumers=[dict(id=str(i),generation=1,spec=spec) for i,spec in enumerate(specs)])
    foreground=data_sync(query)
    assert all(item["calculation"]["visible_complete"] for item in foreground["indicators"])
    for item in foreground["indicators"]:
        while jobs.indicator_tick(item["calculation"]["run_id"],raise_errors=True):
            pass
    canonical=data_sync(query.model_copy(update=dict(client=None,indicator_consumers=[])))
    for actual,expected in zip(foreground["indicators"],canonical["indicators"]):
        assert actual["series"]==expected["series"]
        if actual["name"]=="PAIO_V1":
            assert actual["presentation"]==expected["presentation"]
            assert actual["calculation"]["canonical_verified"] is False
            assert actual["series"][11]["values"][-1]["value"] is not None


@pytest.mark.parametrize("policy", ["strict_confirmed_v1", "observed_display_v1"])
def test_fixed_truncated_h4_tail_keeps_drawings_across_foreground_worker_restart(database, monkeypatch, policy):
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.storage import HistoryVersion

    version = history(database, monkeypatch, count=1501)
    with database.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, version), ["H4", "M15", "H1"])
    while artifact_tick(version):
        pass
    specs = [dict(name="EMA", params=dict(period=2)), dict(name="PAIO_V1", params=dict(bi_step=0))]
    query = DataQuery(instrument=version, series_kind="history", timeframe="H4", limit=4,
        indicators=specs, client="paio-partial-test", indicator_input_policy=policy,
        indicator_consumers=[dict(id=str(i), generation=1, spec=spec) for i, spec in enumerate(specs)])
    # A page ending at the last full bucket must not inherit an empty display
    # merely because the shared replay also reads the rejected terminal bucket.
    initial = data_sync(query)
    assert initial["bars"][-1]["end"] > 1501 * 60000
    older_query = query.model_copy(update=dict(before=initial["bars"][-1]["start"]))
    foreground = data_sync(older_query)
    paio = foreground["indicators"][1]
    assert paio["calculation"]["execution"]["path"] == "bounded-fixed-replay"
    assert paio["presentation"]["objects"]
    assert paio["presentation"]["readiness"]["bar_index"]
    assert paio["presentation"]["as_of_bar_time"] == foreground["bars"][-1]["start"]
    for item in initial["indicators"]:
        while jobs.indicator_tick(item["calculation"]["run_id"], raise_errors=True):
            pass
    # Durable state is reconstructed in a new transaction/engine, with no
    # foreground cache. Neither policy is allowed to confirm the truncated bar.
    durable = data_sync(query.model_copy(update=dict(client=None, indicator_consumers=[])))
    paio = durable["indicators"][1]
    assert all(series["values"][-1]["value"] is None for series in paio["series"])
    assert paio["dependencies"][-1]["initialized"] is False
    if policy == "observed_display_v1":
        assert paio["dependencies"][-1]["input_quality"]["reason_code"] == "PARTIAL_PERIOD"
    assert paio["presentation"] == foreground["indicators"][1]["presentation"]
    older = data_sync(older_query.model_copy(update=dict(client=None, indicator_consumers=[])))
    assert older["indicators"][1]["presentation"] == paio["presentation"]
