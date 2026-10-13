"""Fixed composite strategies: dependency gates, seam, recovery and audit."""

import copy

import pytest
from alerts.chart_alert_service import AlertConfig, create, current_version, lifecycle
from alerts.chart_alert_worker import evaluate
from alerts.composite_definitions import first_use, save_mapping
from alerts.config import settings
from alerts.fixed_indicators import indicator_tick
from alerts.history_artifacts import artifact_tick
from alerts.history_versions import create_version, import_page
from alerts.live_pricing import account_key, desired_datasets
from alerts.market_contracts import DatasetIdentity, QuoteEvent
from alerts.storage import (
    ChartAlert,
    CompositeJudgment,
    CompositePreparation,
    CompositeRevision,
    FixedIndicatorRun,
    LiveState,
    MarketComposite,
    MarketDataset,
    MarketDemand,
    Notification,
    Outbox,
    PricingOwner,
    RealtimeMapping,
    SignalRow,
)
from sqlalchemy import func, select
from test_composite_aggregates import drain as aggregate
from test_composite_chart import populated
from test_composite_definitions import PROOF, prepare
from test_fixed_indicators import add_tail
from test_history_versions import Adapter
from test_market_contracts import batch, identity, minute


def config(composite, **changes):
    return AlertConfig.model_validate({"name": "固定组合预警", "instrument": composite,
        "series_kind": "composite", "source": "composite", "timeframe": "M1", "max_triggers": 3,
        "condition": {"relation": "cross_up", "right": {"kind": "constant", "value": "1.115"}}, **changes})


def live(database, revision, stamp, confirmed_end, *, epoch=1, connected=True):
    with database.begin() as db:
        rev = db.get(CompositeRevision, revision)
        prep = db.get(CompositePreparation, revision)
        prep.status, prep.cursor, prep.error = "queried", prep.cutoff, None
        target = db.get(RealtimeMapping, rev.mapping_id).target_dataset_id
        key = account_key(settings.oanda_account_id)
        owner = db.get(PricingOwner, key)
        if not owner:
            owner = PricingOwner(id=key)
            db.add(owner)
        owner.token, owner.expires, owner.epoch = "test-owner", stamp + 60000, epoch
        state = db.get(LiveState, target)
        state.ready, state.connection, state.epoch = connected, "connected" if connected else "disconnected", epoch
        state.heartbeat_at = state.received_at = stamp
        state.confirmed_end, state.error = confirmed_end, None
        state.quote = {"source_time": stamp, "bid": "1.11", "ask": "1.111", "tradeable": True,
                       "connection_epoch": epoch}


def armed(database, monkeypatch, **changes):
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    composite, revision, seam = populated(database, monkeypatch)
    stamp = seam + 600010
    live(database, revision, stamp, seam + 600000)
    aggregate(revision, "M1")
    with database.begin() as db:
        ident = create(db, "composite-rule", config(composite, **changes), at=stamp).id
    return ident, composite, revision, seam, stamp


def append(database, revision, at, close, now):
    add_tail(database, revision, [minute(at, volume="3", close=close)], observed_at=at + 60000)
    aggregate(revision, "M1")
    live(database, revision, now, at + 60000)


def settle(database, ident, stamp):
    for _ in range(50):
        with database.begin() as db:
            events = evaluate(db, ident, now=stamp)
            row = db.get(ChartAlert, ident)
            if row.health not in ("warming",):
                return events
            ids = list(db.scalars(select(FixedIndicatorRun.id).where(FixedIndicatorRun.status == "pending")))
        if not ids:
            return events
        for run in ids:
            while indicator_tick(run):
                pass
    raise AssertionError("strategy readiness did not settle")


def test_fixed_binding_persistent_demand_and_one_transactional_event(database, monkeypatch):
    ident, composite, revision, seam, stamp = armed(database, monkeypatch, notify_ntfy=True)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        row = db.get(ChartAlert, ident)
        bound = current_version(db, row).market_identity
        assert bound["composite_revision_id"] == revision and bound["seam_policy"] == "reject"
        assert row.health == "ready" and row.state["sequence"] == seam + 600000
        assert db.scalar(select(MarketDemand)) is None
    assert set(desired_datasets(settings.oanda_account_id)) == {"EUR_USD"}
    next_time = seam + 660010
    append(database, revision, seam + 600000, "1.119", next_time)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=next_time)) == 1
        assert evaluate(db, ident, now=next_time) == []
        signal = db.scalar(select(SignalRow))
        assert signal.evidence["observation"]["input_manifest"]["composite_revision_id"] == revision
        assert db.scalar(select(func.count()).select_from(Notification)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        assert db.get(ChartAlert, ident).count == 1
    with database.begin() as db:
        row = db.get(ChartAlert, ident)
        lifecycle(db, ident, row.version, "pause", expected_revision=row.control_revision, request_id="pause", at=next_time)
    assert not desired_datasets(settings.oanda_account_id)


@pytest.mark.parametrize('error', ['unauthorized', 'provider_maintenance'])
def test_account_fault_blocks_alert_even_if_another_instrument_still_has_ready_state(database, monkeypatch, error):
    ident, _, _, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        db.get(PricingOwner, account_key(settings.oanda_account_id)).error = error
        assert evaluate(db, ident, now=stamp) == []
        assert db.get(ChartAlert, ident).health == 'stale'
        assert db.scalar(select(SignalRow)) is None


def test_disconnect_recovery_baselines_old_cross_and_later_new_event_triggers(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    outage = seam + 640000
    live(database, revision, outage, seam + 600000, connected=False)
    with database.begin() as db:
        assert evaluate(db, ident, now=outage) == []
        assert db.get(ChartAlert, ident).health == "stale"
    now = seam + 660010
    append(database, revision, seam + 600000, "1.119", now)
    live(database, revision, now, seam + 660000, epoch=2)
    with database.begin() as db:
        assert evaluate(db, ident, now=now) == []
        assert db.get(ChartAlert, ident).runtime["readiness"]["last_outcome"] == "recovery_baseline"
        assert db.scalar(select(SignalRow)) is None
    append(database, revision, seam + 660000, "1.11", seam + 720010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 720010) == []
    append(database, revision, seam + 720000, "1.119", seam + 780010)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 780010)) == 1


def test_correction_rebuild_preserves_judgments_and_never_replays_historical_event(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        evaluate(db, ident, now=seam + 660010)
        original = copy.deepcopy(db.scalar(select(SignalRow)).evidence)
    add_tail(database, revision, [minute(seam + 60000, volume="3", close="1.119")])
    aggregate(revision, "M1")
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660020) == []
        assert db.get(ChartAlert, ident).runtime["readiness"]["last_outcome"] == "recovery_baseline"
        assert db.get(ChartAlert, ident).count == 1
        assert db.scalar(select(SignalRow)).evidence == original
        assert len(list(db.scalars(select(CompositeJudgment)))) == 3
    with pytest.raises(ValueError, match="不可变"):
        with database.begin() as db:
            db.scalar(select(CompositeJudgment)).evidence = {}


def test_missing_confirmation_period_waterline_and_stale_owner_all_fence_rules(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    add_tail(database, revision, [minute(seam + 600000, volume="3")])
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        assert "聚合" in db.get(ChartAlert, ident).health_reason
        assert db.get(ChartAlert, ident).state == {}
    aggregate(revision, "M1")
    live(database, revision, seam + 660010, seam + 600000)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) == []
        assert "水位" in db.get(ChartAlert, ident).health_reason
    live(database, revision, seam + 660010, seam + 660000)
    with database.begin() as db:
        db.get(PricingOwner, account_key(settings.oanda_account_id)).expires = 0
        assert evaluate(db, ident, now=seam + 660010) == []
        assert db.get(ChartAlert, ident).health == "stale"


def continuous(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    catalog = prepare(database, monkeypatch)
    seam = 165600000
    start = seam - 120 * 60000
    with database.begin() as db:
        version = create_version(db, identity().key, start, seam + 60000)
    import_page(Adapter([batch(window_start=start, window_end=seam + 60000, checkpoint=seam + 60000,
        rows=tuple(minute(at) for at in range(start, seam, 60000)))]), version_id=version)
    while artifact_tick(version):
        pass
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: seam + 120010)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        ident, revision = composite.id, composite.active_revision_id
    add_tail(database, revision, [minute(at, volume="3") for at in range(seam, seam + 600000, 60000)])
    aggregate(revision, "M1")
    stamp = seam + 600010
    live(database, revision, stamp, seam + 600000)
    return ident, revision, seam, stamp


def test_complete_recursive_initialization_requires_explicit_raw_seam_policy(database, monkeypatch):
    composite, revision, seam, stamp = continuous(database, monkeypatch)
    condition = {"relation": "cross_up", "left": {"kind": "indicator", "indicator":
        {"name": "EMA", "params": {"period": 19}}}, "right": {"kind": "constant", "value": "1.115"}}
    with database.begin() as db:
        reject = create(db, "seam-reject", config(composite, condition=condition), at=stamp).id
        accept = create(db, "seam-accept", config(composite, condition=condition, seam_policy="accept_raw"), at=stamp).id
    assert settle(database, reject, stamp) == []
    assert settle(database, accept, stamp) == []
    with database.begin() as db:
        assert db.get(ChartAlert, reject).health == "blocked"
        assert "接缝" in db.get(ChartAlert, reject).health_reason
        accepted = db.get(ChartAlert, accept)
        assert accepted.health == "ready"
        dependency = accepted.runtime["readiness"]["dependencies"][0]["dependency"]
        assert dependency["seam_dependency"] and dependency["dependency_origin"] == seam - 120 * 60000


def test_seam_jump_itself_never_compares_prices_or_accepted_indicators(database, monkeypatch):
    composite, revision, seam, stamp = continuous(database, monkeypatch)
    with database.begin() as db:
        ident = create(db, "seam-jump", config(composite), at=seam - 1).id
        alert = db.get(ChartAlert, ident)
        alert.state = {"sequence": seam, "left": "1.10", "right": "1.115", "count": 0}
        alert.runtime = {"last_start": seam - 60000, "confirmed_end": seam}
    add_tail(database, revision, [minute(seam + 540000, volume="3", close="1.119")])
    aggregate(revision, "M1")
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        assert db.scalar(select(SignalRow)) is None
        assert db.get(ChartAlert, ident).runtime["readiness"]["last_outcome"] == "seam_baseline"


def test_indicator_dependency_gap_cannot_be_hidden_by_latest_confirmed_minute(database, monkeypatch):
    composite, revision, seam, stamp = continuous(database, monkeypatch)
    # Missing a minute between the published prefix and a short tail resets the
    # full valid span; the latest confirmed bar alone cannot initialize EMA19.
    add_tail(database, revision, [minute(seam + 660000, volume="3")])
    aggregate(revision, "M1")
    stamp = seam + 720010
    live(database, revision, stamp, seam + 720000)
    with database.begin() as db:
        condition = {"relation": "cross_up", "left": {"kind": "indicator", "indicator":
            {"name": "EMA", "params": {"period": 19}}}, "right": {"kind": "constant", "value": "1.115"}}
        ident = create(db, "gap-dependency", config(composite, condition=condition, seam_policy="accept_raw"), at=stamp).id
    assert settle(database, ident, stamp) == []
    with database.begin() as db:
        assert db.get(ChartAlert, ident).health == "warming"
        assert db.get(ChartAlert, ident).state == {}


def test_normal_async_indicator_append_keeps_comparison_state_and_triggers_new_cross(database, monkeypatch):
    composite, revision, seam, stamp = continuous(database, monkeypatch)
    condition = {"relation": "cross_up", "left": {"kind": "indicator", "indicator":
        {"name": "EMA", "params": {"period": 2}}}, "right": {"kind": "constant", "value": "1.115"}}
    with database.begin() as db:
        ident = create(db, "async-new-event", config(composite, condition=condition, seam_policy="accept_raw"), at=stamp).id
    assert settle(database, ident, stamp) == []
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    assert len(settle(database, ident, seam + 660010)) == 1
    with database.begin() as db:
        signal = db.scalar(select(SignalRow))
        assert signal.evidence["left"] != "1.119"
        assert signal.evidence["observation"]["dependencies"][0]["dependency"]["dependency_origin"] == seam - 120 * 60000


def forming(database, revision, at, stamp, price="1.11", epoch=1):
    live(database, revision, stamp, at, epoch=epoch)
    with database.begin() as db:
        target = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id).target_dataset_id
        state = db.get(LiveState, target)
        state.quote = {"source_time": stamp, "bid": price, "ask": str(float(price) + .001), "tradeable": True}
        state.forming = {"start": at, "end": at + 60000, "open": price, "high": price, "low": price,
                         "close": price, "complete": False, "connection_epoch": epoch, "volume": None}


def test_explicit_sampled_quote_mode_never_mutates_confirmed_state_and_requires_valid_owner(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch, mode="intrabar")
    at, stamp = seam + 600000, seam + 600010
    forming(database, revision, at, stamp)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        assert db.get(ChartAlert, ident).health == "ready"
        before = list(db.scalars(select(FixedIndicatorRun)))
    forming(database, revision, at, stamp + 1000, price="1.119")
    with database.begin() as db:
        assert len(evaluate(db, ident, now=stamp + 1000)) == 1
        signal = db.scalar(select(SignalRow))
        assert signal.evidence["observation"]["observation_basis"] == "sampled_bid_quote"
        assert list(db.scalars(select(FixedIndicatorRun))) == before
    forming(database, revision, at, stamp + 2000, price="1.11")
    with database.begin() as db:
        db.get(PricingOwner, account_key(settings.oanda_account_id)).expires = 0
        assert evaluate(db, ident, now=stamp + 2000) == []
        assert db.get(ChartAlert, ident).health == "stale"


@pytest.mark.parametrize("gap", [15000, 15001, 30000])
def test_intrabar_quote_gap_without_worker_stale_check_rebuilds_baseline(database, monkeypatch, gap):
    from alerts.live_pricing import publish_event

    ident, _, revision, _, stamp = armed(database, monkeypatch, mode="intrabar", notify_ntfy=True)
    with database.begin() as db:
        target = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id).target_dataset_id
        source = DatasetIdentity.model_validate(db.get(MarketDataset, target).identity)
        db.get(LiveState, target).quote = {}
    ownership = (account_key(settings.oanda_account_id), "test-owner")

    def quote(offset, price, sequence):
        event = QuoteEvent(identity=source, source_time=stamp + offset, received_at=stamp + offset,
            bid=price, ask=str(float(price) + .001), tradeable=True, connection_epoch=1, sequence=sequence)
        publish_event(ownership, 1, event, {"EUR_USD": source}, now=stamp + offset)

    quote(0, "1.11", 1)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        assert db.get(ChartAlert, ident).health == "ready"
    # Shared connection stays alive while this symbol has no samples and the
    # alert worker does not evaluate the intervening stale period.
    publish_event(ownership, 1, {"type": "heartbeat", "connection_epoch": 1,
        "received_at": stamp + gap - 1000}, {"EUR_USD": source}, now=stamp + gap - 1000)
    quote(gap, "1.119", 2)
    with database.begin() as db:
        source_state = db.get(LiveState, target)
        assert source_state.epoch == 1 and source_state.ready and source_state.connection == "connected"
        events = evaluate(db, ident, now=stamp + gap)
        if gap <= 15000:
            assert len(events) == 1
            return
        assert events == []
        row = db.get(ChartAlert, ident)
        assert row.count == 0 and row.state["sequence"] == stamp + gap
        judgment = db.scalar(select(CompositeJudgment).where(CompositeJudgment.event_time == stamp + gap))
        assert judgment.outcome == "recovery_baseline" and judgment.evidence["recovery"]
        assert judgment.evidence["observation_gap_ms"] == gap
        for model in (SignalRow, Notification, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 0
        assert evaluate(db, ident, now=stamp + gap) == []
    quote(gap + 1000, "1.11", 3)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp + gap + 1000) == []
    quote(gap + 2000, "1.119", 4)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=stamp + gap + 2000)) == 1
        assert evaluate(db, ident, now=stamp + gap + 2000) == []
        assert db.get(ChartAlert, ident).count == 1
        for model in (SignalRow, Notification, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1


def test_missed_and_expired_events_establish_baseline_without_notifications(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch, notify_ntfy=True, late_delivery="notify")
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    add_tail(database, revision, [minute(seam + 600000, close="1.119", volume="3"),
        minute(seam + 660000, close="1.11", volume="3"), minute(seam + 720000, close="1.119", volume="3")])
    aggregate(revision, "M1")
    live(database, revision, seam + 780010, seam + 780000)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 780010) == []
        assert db.get(ChartAlert, ident).state["sequence"] == seam + 780000
        assert db.scalar(select(SignalRow)) is None and db.scalar(select(Outbox)) is None


def test_duplicate_logical_event_after_state_recovery_keeps_count(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        original = copy.deepcopy(db.get(ChartAlert, ident).state)
        runtime = copy.deepcopy(db.get(ChartAlert, ident).runtime)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 660010)) == 1
        count = db.get(ChartAlert, ident).count
        original["count"] = count
        db.get(ChartAlert, ident).state = original
        db.get(ChartAlert, ident).runtime = runtime
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) == []
        assert db.get(ChartAlert, ident).count == 1
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


def test_active_chart_revision_switch_never_retargets_running_rule(database, monkeypatch):
    ident, composite, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        original = db.get(CompositeRevision, revision)
        new = CompositeRevision(composite_id=composite, history_version_id=original.history_version_id,
            mapping_id=original.mapping_id, parent_revision_id=revision, seam=seam, rules=original.rules,
            request_id="new-chart-only-revision")
        db.add(new)
        db.flush()
        prep = db.get(CompositePreparation, revision)
        db.add(CompositePreparation(revision_id=new.id, cursor=seam, cutoff=prep.cutoff))
        db.get(MarketComposite, composite).active_revision_id = new.id
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 660010)) == 1
        signal = db.scalar(select(SignalRow))
        assert signal.evidence["market_identity"]["composite_revision_id"] == revision
        assert db.get(ChartAlert, ident).runtime["composite_revision_id"] == revision


def test_pure_capabilities_and_authenticated_fixed_creation_geometry_judgments(database, monkeypatch):
    from alerts import api
    from fastapi.testclient import TestClient

    ident, composite, revision, seam, stamp = armed(database, monkeypatch)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            facts = client.post("/api/chart-alerts/capabilities", json={"instrument": composite,
                "series_kind": "composite", "timeframe": "M1"})
            assert facts.status_code == 200 and facts.json()["sources"][0]["source"] == "composite"
            response = client.post("/api/chart-alerts/geometry", json={"instrument": composite,
                "series_kind": "composite", "source": "composite", "timeframe": "M1",
                "composite_revision_id": revision, "kind": "trend_line", "extend_right": True,
                "points": [{"time": seam + 420000, "price": "1.11"}, {"time": seam + 480000, "price": "1.115"}]})
            assert response.status_code == 200, response.text
            assert response.json()["points"][1]["index"] == 1
            rule = config(composite, composite_revision_id=revision).model_dump(mode="json")
            created = client.post("/api/chart-alerts", json={"request_id": "api-fixed-rule", "config": rule})
            assert created.status_code == 201, created.text
            assert created.json()["market_identity"]["composite_revision_id"] == revision
            with database.begin() as db:
                assert evaluate(db, ident, now=stamp) == []
                assert db.scalar(select(MarketDemand)) is None
            record = client.get(f"/api/chart-alerts/{ident}/judgments")
            assert record.status_code == 200 and record.json()[0]["outcome"] == "initial_baseline"
    finally:
        api.app.dependency_overrides.clear()
