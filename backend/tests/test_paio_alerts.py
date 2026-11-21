"""The source's ten predicates use the existing backend event state machine."""

from decimal import Decimal

import pytest
from alerts.chart_alert_domain import Condition, EvaluationState, Indicator, Observation, advance
from alerts.chart_alert_values import operand_values
from alerts.paio_spec import ALERTS
from test_paio import bars


@pytest.mark.parametrize("output",list(ALERTS))
def test_ten_original_conditions_are_boolean_and_continuous_true_fires_per_bar(output):
    condition=Condition.model_validate(dict(relation="above",left=dict(kind="indicator",indicator=dict(
        name="PAIO_V1",output=output)),right=dict(kind="constant",value="0")))
    assert condition.left.unit=="boolean"
    state=EvaluationState(sequence=1,left="1",right="0")
    events=[]
    for index in range(2,5):
        obs=Observation(f"bar:{index}",index,index,Decimal(1),Decimal(0),evidence={"bar":{"start":index}})
        state,event=advance(condition,state,obs,3)
        events.append(event)
        assert advance(condition,state,obs,3)==(state,None)
    assert len([e for e in events if e])==3
    assert state.count==3


def test_intrabar_samples_of_same_candle_do_not_repeat():
    condition=Condition.model_validate(dict(relation="above",left=dict(kind="indicator",indicator=dict(
        name="PAIO_V1",output="pattern_ii")),right=dict(kind="constant",value="0")))
    state=EvaluationState(sequence=1,left="0",right="0")
    def obs(sequence,bar):
        return Observation(f"sample:{sequence}",sequence,sequence,Decimal(1),Decimal(0),evidence={"bar":{"start":bar}})
    state,event=advance(condition,state,obs(2,100),3)
    assert event
    state,event=advance(condition,state,obs(3,100),3)
    assert event is None
    state,event=advance(condition,state,obs(4,200),3)
    assert event and state.count==2


def test_non_original_conditions_rejected_and_atr_cannot_use_boolean():
    with pytest.raises(ValueError):
        Indicator(name="PAIO_V1",output="h_count")
    with pytest.raises(ValueError):
        Condition.model_validate(dict(relation="above",left=dict(kind="indicator",indicator=dict(
            name="PAIO_V1",output="pattern_ii")),right=dict(kind="constant",value="0"),
            offset=dict(timeframe="M5")))


def test_conditions_survive_display_disabled_and_open_is_part_of_cache_identity():
    rows=bars([(0,2),(1,3),(2,4)])
    from alerts.chart_alert_domain import Operand
    operand=Operand.model_validate(dict(kind="indicator",indicator=dict(name="PAIO_V1",output="gap_body_up",
        params=dict(gs_body_use=False))))
    cache={}
    first=operand_values(rows,operand,cache=cache)
    revised=[*rows[:-1],rows[-1]|dict(open=.5,close=.5)]
    second=operand_values(revised,operand,cache=cache)
    assert first!=second and len(cache)==2


def test_chart_closed_background_paio_persists_events_without_replaying(database,monkeypatch):
    from alerts.chart_alert_worker import evaluate
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.storage import ChartAlert, CompositeRevision, HistoryVersion, SignalRow
    from sqlalchemy import func, select
    from test_composite_aggregates import drain
    from test_composite_alerts import armed, live, settle
    from test_fixed_indicators import add_tail
    from test_market_contracts import minute
    condition = dict(relation="above",left=dict(kind="indicator",indicator=dict(name="PAIO_V1",output="gap_open_up")),right=dict(kind="constant",value="0"))
    ident, _, revision, seam, stamp = armed(database,monkeypatch,condition=condition,seam_policy="accept_raw")
    with database.begin() as db:
        version=db.get(CompositeRevision,revision).history_version_id
        request_artifacts(db,db.get(HistoryVersion,version),["M15","H1"])
    while artifact_tick(version):
        pass
    for frame in ("M15","H1"):
        drain(revision,frame)
    assert settle(database,ident,stamp) == []
    for offset, price in ((600000,2),(660000,3)):
        at=seam+offset
        add_tail(database,revision,[minute(at,open=str(price),high=str(price+.1),low=str(price-.1),close=str(price),volume="3")],observed_at=at+60000)
        for frame in ("M1","M15","H1"):
            drain(revision,frame)
        live(database,revision,at+60010,at+60000)
        assert len(settle(database,ident,at+60010)) == 1
        # Independent DB session simulates worker process resume; same input
        # does not replay an event and no chart/MarketDemand is involved.
        with database.begin() as db:
            assert evaluate(db,ident,now=at+60010) == []
    with database.begin() as db:
        assert db.get(ChartAlert,ident).count == 2
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 2
