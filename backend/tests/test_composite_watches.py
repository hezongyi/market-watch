"""Fixed legacy strategies use composite data, not target-source candle copies."""

import copy
from decimal import Decimal

import pytest
from alerts.business import WatchInput, new_watch_in, watch_dict
from alerts.composite_watches import create, evaluate
from alerts.config import settings
from alerts.history_artifacts import artifact_tick
from alerts.live_pricing import desired_datasets
from alerts.storage import (
    CompositePreparation,
    CompositeRevision,
    CompositeWatchBinding,
    CompositeWatchJudgment,
    LiveState,
    MarketComposite,
    Notification,
    Outbox,
    RealtimeMapping,
    SignalRow,
    Watch,
)
from sqlalchemy import func, select
from test_composite_aggregates import drain as aggregate
from test_composite_alerts import append, continuous, forming, live
from test_composite_chart import populated
from test_fixed_indicators import add_tail, history
from test_market_contracts import identity, minute


def test_sma_uses_fixed_history_and_exact_declared_windows(database, monkeypatch):
    composite, revision, seam, stamp = continuous(database, monkeypatch)
    ids = []
    with database.begin() as db:
        for policy in ("reject", "accept_raw"):
            watch = create(db, composite, policy, {"kind": "indicator", "timeframe": "M1", "direction": "buy",
                "indicator_params": {"fast": 2, "slow": 19}}, seam_policy=policy, armed_at=stamp)
            ids.append(watch.id)
    with database.begin() as db:
        for ident in ids:
            assert evaluate(db, ident, now=stamp) is None
        assert db.get(CompositeWatchBinding, ids[0]).health == "warming"
        assert db.get(CompositeWatchBinding, ids[1]).health == "ready"
        state = db.get(Watch, ids[1]).state
        assert len(state["indicator_closes"]) == 19
        assert float(state["indicator_reading"]["value"]) == pytest.approx(1.11)
        assert float(state["indicator_reading"]["reference"]) == pytest.approx(1.11)
    append(database, revision, seam + 600000, "1.10", seam + 660010)
    with database.begin() as db:
        assert evaluate(db, ids[0], now=seam + 660010) is None
        assert evaluate(db, ids[1], now=seam + 660010) is None
    append(database, revision, seam + 660000, "1.119", seam + 720010)
    with database.begin() as db:
        assert evaluate(db, ids[0], now=seam + 720010) is None
        assert evaluate(db, ids[1], now=seam + 720010) is None
    append(database, revision, seam + 720000, "1.119", seam + 780010)
    with database.begin() as db:
        assert evaluate(db, ids[0], now=seam + 780010) is None
        assert evaluate(db, ids[1], now=seam + 780010)
        evidence = db.scalar(select(SignalRow)).evidence
        assert evidence["dependencies"][0]["start"] < seam
        assert evidence["market_identity"]["seam_policy"] == "accept_raw"


def test_pullback_readiness_survives_beyond_any_short_lookback(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch, kind="pullback", level=None)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    rows = [minute(seam + 600000, open="1.111", high="1.115", low="1.10", close="1.11", volume="3"),
            minute(seam + 660000, open="1.11", high="1.115", low="1.09", close="1.10", volume="3")]
    rows += [minute(at, open="1.10", high="1.115", low="1.09", close="1.10", volume="3")
             for at in range(seam + 720000, seam + 1920000, 60000)]
    add_tail(database, revision, rows)
    aggregate(revision, "M1")
    live(database, revision, seam + 1920010, seam + 1920000)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 1920010) is None
        assert db.get(Watch, ident).state["buy_ready"]
        assert db.scalar(select(SignalRow)) is None
    append(database, revision, seam + 1920000, "1.119", seam + 1980010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 1980010)
        assert db.get(Watch, ident).status == "triggered"


def test_missing_previous_daily_context_is_never_replaced_by_an_older_day(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch, kind="previous_day", level=None)
    aggregate(revision, "D1")
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) is None
        assert db.get(CompositeWatchBinding, ident).health == "warming"
        assert "交易日" in db.get(CompositeWatchBinding, ident).health_reason
        assert db.get(Watch, ident).state["previous"] is None
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    aggregate(revision, "D1")
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) is None
        assert db.scalar(select(SignalRow)) is None


def test_sampled_price_requires_quote_epoch_and_baselines_recovery(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch, timeframe="tick")
    at, stamp = seam + 600000, seam + 600010
    forming(database, revision, at, stamp)
    with database.begin() as db:
        target = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id).target_dataset_id
        state = db.get(LiveState, target)
        state.quote = {**state.quote, "connection_epoch": 1}
        assert evaluate(db, ident, now=stamp) is None
        assert db.get(CompositeWatchBinding, ident).health == "ready"
    forming(database, revision, at, stamp + 1000, price="1.119", epoch=2)
    with database.begin() as db:
        state = db.get(LiveState, target)
        state.quote = {**state.quote, "connection_epoch": 1}
        assert evaluate(db, ident, now=stamp + 1000) is None
        assert db.get(CompositeWatchBinding, ident).health == "stale"
        state.quote = {**state.quote, "connection_epoch": 2}
        assert evaluate(db, ident, now=stamp + 1000) is None
        assert db.scalar(select(SignalRow)) is None
    for delta, price in ((2000, "1.11"), (3000, "1.119")):
        forming(database, revision, at, stamp + delta, price=price, epoch=2)
        with database.begin() as db:
            state = db.get(LiveState, target)
            state.quote = {**state.quote, "connection_epoch": 2}
            result = evaluate(db, ident, now=stamp + delta)
            assert bool(result) == (delta == 3000)


def test_full_origin_warmup_is_batched_and_keeps_checkpoint(database, monkeypatch):
    from alerts.composite_definitions import first_use, save_mapping
    from test_composite_definitions import PROOF

    version = history(database, monkeypatch, count=3007)
    seam = 165600000
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: seam + 120010)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, "HC:" + "a" * 36, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        revision, composite_id = composite.active_revision_id, composite.id
    while artifact_tick(version):
        pass
    add_tail(database, revision, [minute(at, volume="3") for at in range(seam, seam + 600000, 60000)])
    aggregate(revision, "M1")
    stamp = seam + 600010
    live(database, revision, stamp, seam + 600000)
    with database.begin() as db:
        ident = create(db, composite_id, "完整前缀", {"kind": "price", "timeframe": "M1", "level": "10"}, armed_at=stamp).id
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) is None
        binding = db.get(CompositeWatchBinding, ident)
        assert binding.health == "warming"
        assert binding.runtime["warmup"]["cursor"] == 2000 * 60000
        first_cursor = db.get(Watch, ident).state["last_event"]
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) is None
        binding = db.get(CompositeWatchBinding, ident)
        assert binding.runtime["warmup"]["cursor"] == seam + 600000
        assert binding.runtime["warmup"]["target_end"] == seam + 660000
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) is None
        binding = db.get(CompositeWatchBinding, ident)
        assert binding.health == "ready", binding.health_reason
        assert "warmup" not in binding.runtime
        assert db.get(Watch, ident).state["last_event"] > first_cursor
        assert db.scalar(select(SignalRow)) is None


def test_previous_day_uses_exact_fixed_daily_artifact_and_triggers(database, monkeypatch):
    from alerts.composite_definitions import first_use, save_mapping
    from alerts.history_artifacts import artifact_tick
    from alerts.history_versions import create_version, import_page
    from test_composite_definitions import PROOF, prepare
    from test_history_versions import Adapter
    from test_market_contracts import batch

    catalog = prepare(database, monkeypatch)
    seam, end = 165600000, 165660000
    with database.begin() as db:
        version = create_version(db, identity().key, 0, end)
    import_page(Adapter([batch(window_end=end, checkpoint=end,
        rows=tuple(minute(at) for at in range(0, end, 60000)))]), version_id=version)
    while artifact_tick(version):
        pass
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: seam + 120010)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        revision, composite_id = composite.active_revision_id, composite.id
    add_tail(database, revision, [minute(at, volume="3") for at in range(seam, seam + 600000, 60000)])
    for frame in ("M1", "D1"):
        aggregate(revision, frame)
    while artifact_tick(version):
        pass
    stamp = seam + 600010
    live(database, revision, stamp, seam + 600000)
    with database.begin() as db:
        ident = create(db, composite_id, "前日突破", {"kind": "previous_day", "timeframe": "M1", "direction": "buy"},
            seam_policy="accept_raw", armed_at=stamp).id
    for _ in range(2):
        with database.begin() as db:
            assert evaluate(db, ident, now=stamp) is None
    with database.begin() as db:
        binding = db.get(CompositeWatchBinding, ident)
        assert binding.health == "ready", binding.health_reason
        assert binding.runtime["previous_day"]["start"] == seam - 86400000
        assert binding.runtime["previous_day"]["high"] == "1.12"
    add_tail(database, revision, [minute(seam + 600000, high="1.14", close="1.13", volume="3")])
    for frame in ("M1", "D1"):
        aggregate(revision, frame)
    live(database, revision, seam + 660010, seam + 660000)
    with database.begin() as db:
        signal = evaluate(db, ident, now=seam + 660010)
        assert signal and signal.threshold == Decimal("1.12")
        assert signal.evidence["previous_day"]["start"] == seam - 86400000


def armed(database, monkeypatch, **changes):
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    composite, revision, seam = populated(database, monkeypatch)
    stamp = seam + 600010
    live(database, revision, stamp, seam + 600000)
    aggregate(revision, "M1")
    rule = {"kind": "price", "timeframe": "M1", "direction": "buy", "level": "1.115", **changes}
    with database.begin() as db:
        ident = create(db, composite, "固定组合策略", rule, armed_at=stamp).id
    return ident, composite, revision, seam, stamp


def test_fixed_binding_one_event_and_durable_demand(database, monkeypatch):
    ident, composite, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) is None
        watch = db.get(Watch, ident)
        binding = db.get(CompositeWatchBinding, ident)
        assert watch_dict(watch)["market_identity"]["composite_revision_id"] == revision
        assert binding.health == "ready", binding.health_reason
        assert watch.state["last_event"] == seam + 600000
    assert set(desired_datasets(settings.oanda_account_id)) == {"EUR_USD"}
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        signal = evaluate(db, ident, now=seam + 660010)
        assert signal and signal.event_key.startswith("cw:")
        assert signal.evidence["market_identity"]["composite_revision_id"] == revision
        assert signal.evidence["input_revision"] == 2
        assert evaluate(db, ident, now=seam + 660010) is None
        for model in (SignalRow, Notification, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1
        assert db.scalar(select(func.count()).select_from(CompositeWatchJudgment)) == 2
    assert not desired_datasets(settings.oanda_account_id)


def test_recovery_and_correction_never_replay_cross(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    live(database, revision, stamp + 1000, seam + 600000, connected=False)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp + 1000) is None
        assert db.get(CompositeWatchBinding, ident).health == "stale"
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) is None
        assert db.scalar(select(SignalRow)) is None
        evidence = copy.deepcopy(db.scalar(select(CompositeWatchJudgment).where(
            CompositeWatchJudgment.outcome == "initial_baseline")).evidence)
    append(database, revision, seam + 600000, "1.11", seam + 660020)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660020) is None
        assert db.scalar(select(CompositeWatchJudgment).where(
            CompositeWatchJudgment.outcome == "initial_baseline")).evidence == evidence
        assert db.scalar(select(SignalRow)) is None
    append(database, revision, seam + 660000, "1.119", seam + 720010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 720010)


def test_chart_activation_cannot_move_existing_strategy(database, monkeypatch):
    ident, composite, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        parent = db.get(CompositeRevision, revision)
        new = CompositeRevision(composite_id=composite, history_version_id=parent.history_version_id,
            mapping_id=parent.mapping_id, seam=parent.seam, rules=parent.rules,
            parent_revision_id=revision, request_id="chart-only")
        db.add(new)
        db.flush()
        db.add(CompositePreparation(revision_id=new.id, cursor=seam, cutoff=seam + 600000))
        db.get(MarketComposite, composite).active_revision_id = new.id
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010).evidence["market_identity"]["composite_revision_id"] == revision


def test_interface_keeps_legacy_rule_schema_and_fixed_input_immutable(database, monkeypatch):
    _, composite, revision, _, _ = armed(database, monkeypatch)
    body = WatchInput(instrument_id=composite, series_kind="composite", name="接口", kind="indicator",
        timeframe="M1", indicator_params={"fast": 2, "slow": 3}, seam_policy="accept_raw")
    with database.begin() as db:
        response = new_watch_in(db, body)
        assert response["health"] == "warming"
        assert response["market_identity"]["composite_revision_id"] == revision
        assert "seam_policy" not in response["rule"]
        ident = response["id"]
    with pytest.raises(ValueError, match="不可变"):
        with database.begin() as db:
            db.get(CompositeWatchBinding, ident).market_identity = {}


def test_missed_events_and_mutated_rules_cannot_emit(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    add_tail(database, revision, [minute(seam + 600000, close="1.119", volume="3"),
        minute(seam + 660000, close="1.11", volume="3"), minute(seam + 720000, close="1.119", volume="3")])
    aggregate(revision, "M1")
    live(database, revision, seam + 780010, seam + 780000)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 780010) is None
        assert db.get(Watch, ident).state["last_event"] == seam + 780000
        assert db.scalar(select(SignalRow)) is None
        watch = db.get(Watch, ident)
        watch.rule = {**watch.rule, "level": "1.10"}
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 780010) is None
        assert db.get(CompositeWatchBinding, ident).health == "blocked"


def test_repeated_logical_event_after_state_rewind_keeps_outbox_single(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        state = copy.deepcopy(db.get(Watch, ident).state)
        runtime = copy.deepcopy(db.get(CompositeWatchBinding, ident).runtime)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010)
        watch = db.get(Watch, ident)
        watch.status, watch.state = "active", state
        db.get(CompositeWatchBinding, ident).runtime = runtime
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) is None
        for model in (SignalRow, Notification, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1


def test_cancelled_watch_keeps_fixed_history_reference(database, monkeypatch):
    from alerts.business import cancel_watch_in
    from alerts.history_retention import references

    ident, _, _, _, _ = armed(database, monkeypatch)
    with database.begin() as db:
        binding = db.get(CompositeWatchBinding, ident)
        cancel_watch_in(db, ident)
        items = references(db, binding.market_identity["dataset_id"])["items"]
        assert any(row["kind"] == "strategy" and row["id"] == ident for row in items)
    assert not desired_datasets(settings.oanda_account_id)


def test_fixed_strategy_only_demands_old_mapping_until_a_chart_opens(database, monkeypatch):
    from alerts.market_contracts import DatasetIdentity
    from alerts.market_data import renew_demand
    from alerts.market_usage import composite_targets, wanted_instruments
    from alerts.storage import Instrument, MarketDataset
    from test_market_datasets import register

    ident, composite, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        parent = db.get(CompositeRevision, revision)
        original = db.get(RealtimeMapping, parent.mapping_id)
        dataset = db.get(MarketDataset, original.target_dataset_id)
        other_identity = DatasetIdentity.model_validate({**dataset.identity, "calendar_version": "explicit-target-calendar-v2"})
        register(db, other_identity)
        target_id = other_identity.key
        mapping = RealtimeMapping(id="e" * 64, dataset_id=original.dataset_id, target_dataset_id=target_id,
            permission_scope=original.permission_scope, match=original.match)
        db.add(mapping)
        db.flush()
        next_revision = CompositeRevision(composite_id=composite, history_version_id=parent.history_version_id,
            mapping_id=mapping.id, parent_revision_id=revision, seam=seam, rules=parent.rules, request_id="different-chart-target")
        db.add(next_revision)
        db.flush()
        owner = db.get(MarketComposite, composite)
        owner.active_revision_id = next_revision.id
        assert composite_targets(db, wanted_instruments(db)) == {dataset.id}
        renew_demand(db, "explicit-chart", db.get(Instrument, owner.instrument_id))
        assert composite_targets(db, wanted_instruments(db)) == {dataset.id, target_id}


def test_no_history_setting_waits_for_post_creation_baseline(database, monkeypatch):
    _, composite, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        ident = create(db, composite, "不预热历史", {"kind": "price", "timeframe": "M1", "level": "1.115"},
            use_history=False, armed_at=stamp).id
        assert evaluate(db, ident, now=stamp) is None
        assert db.get(Watch, ident).state["previous"] is None
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) is None
        assert db.get(CompositeWatchBinding, ident).health == "ready"
        assert db.get(Watch, ident).state["previous"]["start"] == seam + 600000


def test_explicit_revision_captures_existing_watch_indicator_preparation(database, monkeypatch):
    from alerts.composite_revisions import create as create_revision
    from alerts.storage import CompositeRevisionChange
    from test_composite_revisions import request

    composite, revision, body = request(database, monkeypatch)
    with database.begin() as db:
        watch = create(db, composite, "旧固定SMA策略", {"kind": "indicator", "timeframe": "M1",
            "indicator_params": {"fast": 2, "slow": 19}})
        new = create_revision(db, composite, body)
        manifest = db.get(CompositeRevisionChange, new.id).manifest
        assert sorted(item["spec"]["params"]["period"] for item in manifest["warmups"]) == [2, 19]
        assert any(item["id"] == watch.id and item["revision_id"] == revision for item in manifest["affected_rules"])
        assert db.get(CompositeWatchBinding, watch.id).revision_id == revision
