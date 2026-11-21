"""Deterministic request mapping fixtures (runtime Pine oracle still separate)."""

import copy

import pytest
from alerts.chart_indicators import calculate
from alerts.paio import PaioState
from alerts.paio_inputs import attach, boundaries, requests, validate_presentation
from alerts.paio_spec import PARAMS
from test_paio import bars


def test_requests_include_hidden_ema_but_not_chart_based_pv():
    assert requests([dict(name="PAIO_V1",params={"ma_2_use":False})],"H4") == ["H1","M15"]
    assert requests([dict(name="PAIO_V1",params={"pvBaseChart":False})],"H4") == ["D1","H1","M15"]


def test_htf_gaps_on_returns_only_at_confirmation_and_fallback_is_not_recursive():
    rows=bars([(0,2),(2,4),(4,6),(6,8),(8,10),(10,12)],duration=300000)
    dep=bars([(0,6),(6,12)],duration=900000)
    params=PARAMS|dict(ma_2_length=3)
    prepared=attach(rows,params,dict(frames={"M15":dict(rows=dep,revision=1)}),chart_frame="M5")
    assert [row["paio_context"]["ema"]["2"] for row in prepared] == [None,None,3,None,None,6]
    result=calculate(prepared,dict(name="PAIO_V1",params=params))
    assert next(s for s in result["series"] if s["key"]=="ema_2")["values"] == [
        dict(time=i*300000,value=v) for i,v in enumerate([None,None,3,5,6,6])]


def test_ltf_uses_last_actual_intrabar_not_aggregated_chart_price():
    rows=bars([(0,100),(0,200)],duration=4*3600000)
    dep=bars([(i,i+2) for i in range(32)],duration=900000)
    params=PARAMS|dict(ma_2_length=1,pvBaseChart=False,pv1stTF="15",pv1stSource="CurrentOpen")
    prepared=attach(rows,params,dict(frames={"M15":dict(rows=dep,revision=7)}),chart_frame="H4")
    assert [r["paio_context"]["ema"]["2"] for r in prepared] == [16,32]
    assert [r["paio_context"]["pv"]["1"] for r in prepared] == [16,32]


def test_missing_dependency_is_not_reconstructed_from_h4():
    rows=bars([(0,100)],duration=4*3600000)
    prepared=attach(rows,PARAMS,dict(frames={}),chart_frame="H4")
    result=calculate(prepared,dict(name="PAIO_V1"))
    assert result["presentation"]["readiness"]["ema_2"] is False
    assert result["presentation"]["readiness"]["ema_1"] is True


def test_request_cursor_resume_matches_full_prefix():
    rows=bars([(i,i+2) for i in range(12)],duration=300000)
    dep=bars([(i,i+2) for i in range(4)],duration=900000)
    params=PARAMS|dict(ma_2_length=3)
    frozen=dict(frames={"M15":dict(rows=dep,revision=1)})
    expected=attach(rows,params,frozen,chart_frame="M5")
    engine=PaioState(params)
    for row in attach(rows[:6],params,frozen,chart_frame="M5"):
        engine.step(row)
    resumed=attach(rows[6:],params,frozen,chart_frame="M5",state=engine.state)
    assert [r["paio_context"]["ema"] for r in resumed] == [r["paio_context"]["ema"] for r in expected[6:]]


def test_live_request_is_withdrawn_and_never_commits_higher_period_state():
    rows=bars([(0,10),(0,12)],duration=300000)
    rows[-1]["complete"]=False
    dependency=bars([(0,20)],duration=900000)
    dependency[-1]["complete"]=False
    frozen=dict(frames={"M15":dict(rows=dependency,revision=1)},as_of=550000)
    prepared=attach(rows,PARAMS,frozen,chart_frame="M5",provisional=True)
    assert prepared[-1]["paio_context"]["ema"]["2"]==10
    assert prepared[-1]["paio_context"]["requests"]["ema_2"]=={}
    assert calculate(prepared,dict(name="PAIO_V1"),provisional=True)["presentation"]["provisional"] is True
    assert calculate(prepared,dict(name="PAIO_V1"))["presentation"]["objects"]==[]


def test_ny17_dst_day_boundary_is_23_hours_not_fixed_utc():
    from datetime import datetime

    row=bars([(0,1)])[0]|dict(start=int(datetime.fromisoformat("2026-03-08T22:30:00+00:00").timestamp()*1000),indicator_calendar="ny17")
    left,right,next_end=boundaries(row,"1D")
    assert left<row["start"]<right<next_end
    assert left%86400000==21*3600000


def test_presentation_contract_is_independent_and_rejects_invalid_geometry():
    rows=bars([(0,1),(3,4)])
    snapshot=calculate(rows,dict(name="PAIO_V1"))["presentation"]
    validate_presentation(snapshot)
    invalid=copy.deepcopy(snapshot)
    invalid["objects"][0]["time"]=float("nan")
    with pytest.raises(ValueError):
        validate_presentation(invalid)


def test_yahoo_default_daily_calendar_and_ioi_anchor_geometry():
    from datetime import datetime
    row = bars([(10, 12)])[0] | dict(start=int(datetime.fromisoformat("2026-11-20T15:00:00+00:00").timestamp()*1000),
        indicator_calendar="yahoo", indicator_timezone="America/New_York", indicator_session="0930-1600", indicator_timeframe="M5")
    result = calculate([row], dict(name="PAIO_V1"))
    assert result["presentation"]["readiness"]["bar_index"]
    rows = bars([(0, 10), (-1, 11), (1, 9)])
    result = calculate(rows, dict(name="PAIO_V1"))
    obj = next(obj for obj in result["presentation"]["objects"] if obj.get("text") == "ioi")
    assert (obj["time"], obj["bar_low"], obj["bar_high"]) == (60000, -1, 11)


def test_observed_preview_objects_and_provisional_flag_are_withdrawn():
    from alerts.observed_indicators import ObservedState
    rows = bars([(0, 10), (1, 9), (2, 8)])
    engine = ObservedState(dict(name="PAIO_V1"))
    for row in rows[:2]:
        engine.step(row)
    before = engine.checkpoint()
    values = engine.step(rows[-1] | dict(complete=False), provisional=True)
    assert values["pattern_ii"] == 1
    assert engine.checkpoint() == before
    assert engine.last_presentation["provisional"] is True
    assert any(obj.get("text") == "ii" for obj in engine.last_presentation["objects"])
    engine.step(rows[-1] | dict(high=12,low=-2))
    assert engine.last_presentation["provisional"] is False
    assert not any(obj.get("text") == "ii" for obj in engine.last_presentation["objects"])


def test_provider_checkpoint_work_is_tail_bounded_and_matches_replay():
    from alerts.chart_calculation_history import calculation_rows
    from alerts.provider_indicator_inputs import Inputs, compute
    meta = dict(calendar="utc0")
    rows = bars([(i%7, i%7+10) for i in range(1200)], duration=300000)
    dependency = bars([(i%9, i%9+10) for i in range(401)], duration=900000)
    spec = dict(name="PAIO_V1")
    for count in (600, 1200, 1200):
        frozen = dict(frames={"M15":dict(rows=dependency,revision=count,epoch="stable",origin=0)}, as_of=count*300000)
        inputs = Inputs(rows[:count], ("paio-perf",), "unchanged", count, frozen)
        telemetry = {}
        actual = compute(inputs,meta,"TEST",spec,first=0,provisional=True,telemetry=telemetry,timeframe="M5")
        prepared = attach(calculation_rows(rows[:count],meta,"TEST","M5",infer_gaps=False),PARAMS,frozen,chart_frame="M5",provisional=True)
        expected = calculate(prepared,spec,provisional=True)
        assert [item["values"] for item in actual["series"]] == [item["values"] for item in expected["series"]]
        assert actual["presentation"] == expected["presentation"]
        assert telemetry["calculation_steps"] <= (601 if count == 1200 and telemetry["checkpoint_index"] == 599 else 600 if count == 600 else 1)


def test_ny17_previous_value_projection_skips_closed_weekend():
    from datetime import datetime
    row=bars([(1,2)])[0] | dict(start=int(datetime.fromisoformat("2026-11-20T15:00:00+00:00").timestamp()*1000),indicator_calendar="ny17",indicator_timeframe="M5")
    _, right, next_end = boundaries(row,"1D")
    assert datetime.fromtimestamp(right/1000, __import__('datetime').timezone.utc).isoformat() == "2026-11-20T22:00:00+00:00"
    assert datetime.fromtimestamp(next_end/1000, __import__('datetime').timezone.utc).isoformat() == "2026-11-23T22:00:00+00:00"


def test_provider_price_credential_pins_request_tails_and_rejects_corrections(database):
    from alerts import provider_cache as cache
    from alerts.paio_inputs import freeze_provider
    from alerts.provider_display_snapshots import capture
    from alerts.storage import ProviderDataset
    from test_provider_cache import META, page, seed
    main=seed(META,"M1",1000000,page(1000,1000000,boundary=True))
    for frame in ("M15","H1"):
        seed(META,frame,1000000,page(1000,1000000,boundary=True))
    with database.begin() as db:
        dataset=db.get(ProviderDataset,main)
        dataset.metadata_json={**dataset.metadata_json,"paio_dependency_frames":["M15","H1"]}
    price=cache.snapshot(main,1000000,10)
    price['dataset_id']=main
    with database.begin() as db:
        capture(db,price)
    credential=price['_provider_snapshot']
    expected=credential['paio_requests']['M15']['tail']['close']
    seed(META,"M15",1000000,page(999000,1000000,close="2.6",complete=False))
    with database.begin() as db:
        frozen=freeze_provider(db,db.get(ProviderDataset,main),[dict(name="PAIO_V1")],price['bars'],credential=credential)
    assert frozen['frames']['M15']['rows'][-1]['close']==expected
    seed(META,"M15",301000,page(300000,301000,close="3.1"))
    from alerts.display_snapshots import DisplaySnapshotError
    with database.begin() as db,pytest.raises(DisplaySnapshotError):
        freeze_provider(db,db.get(ProviderDataset,main),[dict(name="PAIO_V1")],price['bars'],credential=credential)


def test_cold_paio_request_registers_dependencies_and_new_price_token_recovers(database,monkeypatch):
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from alerts.chart_query import DataQuery
    from alerts.display_snapshots import DisplaySnapshotError
    from test_provider_cache import META, page, seed
    monkeypatch.setattr(upstream,"metadata",lambda _:META)
    for frame in ("M1","M15","H1"):
        seed(META,frame,1000000,page(1000,1000000,boundary=True))
    query=DataQuery(instrument=META["id"],series_kind="provider",timeframe="M1",before=1000000,limit=20)
    original=cache.data(query)
    spec=dict(name="PAIO_V1")
    with pytest.raises(DisplaySnapshotError):
        cache.data(query.model_copy(update=dict(indicators=[spec],provider_snapshot_id=original["provider_snapshot_id"])))
    refreshed=cache.data(query)
    assert refreshed["provider_snapshot_id"] != original["provider_snapshot_id"]
    result=cache.data(query.model_copy(update=dict(indicators=[spec],provider_snapshot_id=refreshed["provider_snapshot_id"])))
    assert result["indicators"][0]["presentation"]["readiness"]["ema_2"]
    repeated=cache.data(query.model_copy(update=dict(indicators=[spec],provider_snapshot_id=refreshed["provider_snapshot_id"])))
    assert repeated["indicators"][0]["calculation"]["execution"]["calculation_steps"] == 1


def test_late_dependency_append_invalidates_committed_provider_prefix():
    from alerts.chart_calculation_history import calculation_rows
    from alerts.provider_indicator_inputs import Inputs, compute
    rows = bars([(i % 11, i % 11 + 4) for i in range(100)], duration=300000)
    dependency = bars([(i % 7, i % 7 + 4) for i in range(34)], duration=900000)
    meta, spec = dict(calendar="utc0"), dict(name="PAIO_V1")
    for count in (20, 34):
        frozen = dict(frames={"M15":dict(rows=dependency[:count],revision=count,epoch="stable",origin=0)})
        telemetry = {}
        actual = compute(Inputs(rows,("late-dependency",),"stable",count,frozen),meta,"TEST",spec,
            first=0,provisional=True,telemetry=telemetry,timeframe="M5")
        expected = calculate(attach(calculation_rows(rows,meta,"TEST","M5",infer_gaps=False),PARAMS,
            frozen,chart_frame="M5",provisional=True),spec,provisional=True)
        assert [item["values"] for item in actual["series"]] == [item["values"] for item in expected["series"]]
        if count == 34:
            assert telemetry["checkpoint_index"] == 0


def test_ltf_gap_does_not_map_bar_outside_current_chart_interval():
    rows = bars([(0,100)], duration=14400000) + bars([(0,200)],start=28800000,duration=14400000)
    dep = bars([(0,10)],duration=900000) + bars([(10,20)],start=21600000,duration=900000)
    params = PARAMS | dict(pvBaseChart=False,pv1stTF="15")
    prepared = attach(rows,params,dict(frames={"M15":dict(rows=dep)}),chart_frame="H4")
    assert [r["paio_context"]["ema"]["2"] for r in prepared] == [5,None]
    assert [r["paio_context"]["pv"]["1"] for r in prepared] == [5,5]
    # Cursor includes actual source inputs, while the mapped gaps_off value
    # survives a restart independently of the EMA seed.
    state = dict(requests=prepared[0]["paio_context"]["requests"])
    resumed = attach(rows[1:],params,dict(frames={"M15":dict(rows=dep)}),chart_frame="H4",state=state)
    assert resumed[0]["paio_context"]["pv"]["1"] == 5


def test_predecessor_before_origin_cannot_seed_requested_ema(database):
    from alerts.paio_inputs import freeze_provider
    from alerts.storage import ProviderDataset
    from test_provider_cache import META, page, seed
    main=seed(META,"H4",1000000,page(900000,1000000,boundary=True))
    seed(META,"M15",1000000,{"bars":[
        page(0,100000,close="100")["bars"][0],
        page(950000,1000000,close="2")["bars"][0]],"history_boundary":True})
    with database.begin() as db:
        result=freeze_provider(db,db.get(ProviderDataset,main),[dict(name="PAIO_V1")],
            [dict(start=900000,end=1000000)])
    assert [row["start"] for row in result["frames"]["M15"]["rows"]] == [950000]


def test_price_credential_does_not_reinsert_pre_origin_dependency(database):
    from alerts import provider_cache as cache
    from alerts.paio_inputs import freeze_provider
    from alerts.provider_display_snapshots import capture
    from alerts.storage import ProviderDataset
    from test_provider_cache import META, page, seed
    main=seed(META,"H4",1000000,page(900000,1000000,boundary=True))
    seed(META,"M15",1000000,page(0,1000,close="100",boundary=True))
    with database.begin() as db:
        dataset=db.get(ProviderDataset,main)
        dataset.metadata_json={**dataset.metadata_json,"paio_dependency_frames":["M15"]}
        price=cache.snapshot(main,1000000,10)
        price["dataset_id"]=main
        capture(db,price)
        frozen=freeze_provider(db,dataset,[dict(name="PAIO_V1")],price["bars"],credential=price["_provider_snapshot"])
        assert frozen["frames"]["M15"]["rows"]==[]
        assert frozen["frames"]["M15"]["origin"] is None
