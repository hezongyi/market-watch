"""Price reliability regressions through production collection/evaluation APIs."""

from alerts import live_pricing
from alerts.chart_alert_service import current_version
from alerts.chart_alert_worker import evaluate
from alerts.market_contracts import DatasetIdentity
from alerts.storage import ChartAlert, LiveState, SignalRow
from sqlalchemy import select
from test_composite_alerts import append, armed, live
from test_live_pricing import quote


def test_collector_keeps_intermediate_cross_before_worker_runs(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar")
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        identity = DatasetIdentity.model_validate(current_version(db, alert).market_identity["target_identity"])
        state = db.get(LiveState, identity.key)
        state.quote = {**state.quote, "sequence": 0, "received_at": stamp}
        evaluate(db, ident, now=stamp)
    ownership = (live_pricing.account_key(live_pricing.settings.oanda_account_id), "test-owner")
    for seq, price in enumerate(("1.110", "1.120", "1.110"), 1):
        at = stamp + seq * 100
        live_pricing.publish_event(ownership, 1,
            quote(identity, 1, seq=seq, source=at, received_at=at, bid=price),
            {"EUR_USD": identity}, now=at)
    with database.begin() as db:
        signals = evaluate(db, ident, now=stamp + 1000)
        assert len(signals) == 1
        assert signals[0].evidence["price"] == "1.120"
        assert db.get(ChartAlert, ident).count == 1
        assert evaluate(db, ident, now=stamp + 1001) == []


def test_close_consumes_intermediate_confirmed_bar(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    append(database, revision, seam + 660000, "1.110", seam + 720010)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 720010)) == 1
        assert db.scalar(select(SignalRow)).occurred_at == seam + 660000


def test_temporary_input_fault_keeps_enabled_intent(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch, mode="intrabar")
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    live(database, revision, stamp, seam + 600000, connected=False)
    with database.begin() as db:
        evaluate(db, ident, now=stamp + 60000)
        alert = db.get(ChartAlert, ident)
        assert alert.status == "active"
        assert alert.runtime["execution_state"] == "recovering"
