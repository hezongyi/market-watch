"""ATR time joins, real-price refresh transitions and durable rule integration."""

import hashlib
import json
from decimal import Decimal as D

import pytest
from alerts.chart_alert_domain import AtrOffset, Condition, EvaluationState, Observation, advance
from alerts.chart_alert_offsets import apply, rebase, reference_bar, resolve
from alerts.chart_alert_service import AlertConfig, config_hash, consume, create, current_version
from alerts.chart_alert_worker import evaluate
from alerts.composite_series import period
from alerts.storage import Bar, ChartAlert, Notification, Outbox, SignalRow
from sqlalchemy import func, select


def condition(**changes):
    return Condition.model_validate({"relation": "cross_up", "right": {"kind": "constant", "value": "100"},
        "offset": {"timeframe": "M1", "period": 2, "multiplier": "0.5"}, **changes})


@pytest.mark.parametrize("before,after,old,new,expected", [
    ("101.5", "101.5", "2", "1", False),
    ("100.8", "101.2", "2", "1", True),
    ("100.8", "100.9", "2", "1", False),
    ("101.5", "102.5", "1", "2", True),
])
def test_refresh_keeps_first_real_sample(before, after, old, new, expected):
    state = EvaluationState(1, before, str(D(100) + D(old)), 0)
    translated, evidence = rebase(state, {"signed_offset": old}, {"signed_offset": new})
    assert translated.sequence == state.sequence and translated.left == before
    assert evidence["offset_change"] == str(D(new) - D(old))
    _, trigger = advance(condition(), translated, Observation("real", 2, 2, D(after), D(100) + D(new)), 3)
    assert bool(trigger) == expected


@pytest.mark.parametrize("relation", ["cross", "enter", "exit", "break_upper", "break_lower"])
def test_unsupported_relations_reject_offset(relation):
    with pytest.raises(ValueError):
        condition(relation=relation)


@pytest.mark.parametrize("name", ["RSI", "MACD"])
def test_non_price_units_reject_offset(name):
    with pytest.raises(ValueError):
        condition(left={"kind": "indicator", "indicator": {"name": name}})


@pytest.mark.parametrize("multiplier", ["0", "-1", "NaN", "Infinity", "100.1"])
def test_invalid_multiplier(multiplier):
    with pytest.raises(ValueError):
        AtrOffset(timeframe="D1", multiplier=multiplier)


def test_open_time_join_excludes_current_at_shared_close_and_smaller_frames():
    day = 86400000 * 20000
    meta = {"calendar": "utc0"}
    assert reference_bar(day + 20 * 3600000, "D1", meta, "BTCUSDT") == (day - 86400000, day)
    assert reference_bar(day + 86400000, "D1", meta, "BTCUSDT") == (day, day + 86400000)
    assert reference_bar(day + 4 * 3600000, "H1", meta, "BTCUSDT") == (day + 3 * 3600000, day + 4 * 3600000)
    assert reference_bar(day + 4 * 3600000, "H4", meta, "BTCUSDT") == (day, day + 4 * 3600000)


def test_ny17_weekend_and_dst_follow_calendar():
    from datetime import datetime
    start = int(datetime.fromisoformat("2026-11-01T22:00:00+00:00").timestamp() * 1000)
    # Monday's open reference is Friday's trading session, crossing DST Sunday.
    reference = reference_bar(start, "D1", {"calendar": "ny17"}, "EURUSD")
    assert reference[1] == int(datetime.fromisoformat("2026-10-30T21:00:00+00:00").timestamp() * 1000)
    assert reference == period(reference[0], "D1", "ny17")


def config(**changes):
    return AlertConfig.model_validate({"name": "ATR test", "instrument": "BTCUSDT", "source": "binance",
        "timeframe": "M1", "max_triggers": 3, "condition": condition().model_dump(mode="json"), **changes})


def seed(db, rows):
    for index, (close, width) in enumerate(rows):
        start = index * 60000
        db.add(Bar(instrument_id="BTCUSDT", timeframe="M1", start=start, end=start + 60000,
            open=D(close), close=D(close), high=D(close) + D(width) / 2,
            low=D(close) - D(width) / 2, complete=True, observed_at=start + 60000,
            received_at=start + 60000))
    db.flush()


def test_legacy_null_config_keeps_original_hash_and_request_replay(database):
    plain = config(condition={"relation": "cross_up", "right": {"kind": "constant", "value": "100"}})
    payload = plain.model_dump(mode="json")
    payload["condition"].pop("offset")
    legacy = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert config_hash(plain) == legacy
    with database.begin() as db:
        alert = create(db, "legacy", plain, at=1)
        alert.request_hash = legacy
        assert create(db, "legacy", AlertConfig.model_validate(payload), at=2).id == alert.id


def test_worker_uses_previous_atr_and_persists_atomic_checkpoint(database):
    with database.begin() as db:
        seed(db, [(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)])
        ident = create(db, "atr-background", config(notify_ntfy=True), at=180000).id
        assert len(evaluate(db, ident, now=300001)) == 1
        row = db.get(ChartAlert, ident)
        assert row.runtime["offset"]["reference_end"] == 240000
        assert row.runtime["atr_calculation"]["origin"] == 0
        signal = db.scalar(select(SignalRow))
        details = signal.evidence["observation"]["offset"]
        assert details["atr"] == "3.0" and details["threshold"] == "101.50"
        assert details["reference_end"] <= signal.evidence["observation"]["bar"]["start"]
        assert db.scalar(select(func.count()).select_from(Notification)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
    with database.begin() as db:
        assert evaluate(db, ident, now=300002) == []
        assert db.get(ChartAlert, ident).count == 1


def test_transaction_rollback_does_not_double_translate_or_deliver(database):
    with database.begin() as db:
        seed(db, [(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)])
        ident = create(db, "atr-rollback", config(notify_ntfy=True), at=180000).id
        evaluate(db, ident, now=240001)
    with pytest.raises(RuntimeError), database.begin() as db:
        assert len(evaluate(db, ident, now=300001)) == 1
        raise RuntimeError("rollback after outbox")
    with database.begin() as db:
        assert len(evaluate(db, ident, now=300001)) == 1
        assert db.get(ChartAlert, ident).count == 1
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


def test_atr_revision_is_blocked_and_original_evidence_stays_immutable(database):
    with database.begin() as db:
        seed(db, [(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)])
        ident = create(db, "atr-revision", config(), at=180000).id
        evaluate(db, ident, now=300001)
        snapshot = db.scalar(select(SignalRow)).evidence
    with database.begin() as db:
        bar = db.scalar(select(Bar).where(Bar.start == 60000, Bar.instrument_id == "BTCUSDT"))
        bar.high += 1
        assert evaluate(db, ident, now=300002) == []
        assert db.get(ChartAlert, ident).health == "blocked"
        assert db.scalar(select(SignalRow)).evidence == snapshot


def test_consume_rebase_retry_and_downward_precision(database):
    rule = config(condition=condition(relation="cross_down").model_dump(mode="json"))
    spec = rule.condition.offset
    with database.begin() as db:
        ident = create(db, "atr-consume", rule, at=1).id
        for seq, price, atr in [(2, "99.2", "4"), (3, "98.8", "2")]:
            offset = resolve(spec, "cross_down", {"start": seq}, {"start": 0, "end": 1, "complete": True}, atr)
            target = apply(D(100), offset)
            sample = Observation(str(seq), seq, seq, D(price), target, D(price), {"offset": offset})
            result = consume(db, ident, sample, detected_at=seq)
            assert consume(db, ident, sample, detected_at=seq) is None
        assert result.evidence["threshold"] == "99.0"
        assert db.get(ChartAlert, ident).count == 1
        assert current_version(db, db.get(ChartAlert, ident)).config["condition"]["offset"]["multiplier"] == "0.5"


def test_provider_second_frame_polled_shared_and_protected_without_browser(database, monkeypatch):
    from alerts import provider_cache, provider_service
    from alerts.storage import ProviderDataset

    meta = {"id": "BTCUSDT", "source": "binance", "symbol": "BTCUSDT",
        "basis": "last", "calendar": "utc0", "precision": 2}
    main = provider_cache.ensure(meta, "M1")
    rule = config(series_kind="provider", condition=condition(offset={
        "timeframe": "D1", "period": 14, "multiplier": "0.2"}).model_dump(mode="json"))
    with database.begin() as db:
        first = create(db, "two-frame-1", rule, dataset_id=main, at=60000)
        second = create(db, "two-frame-2", rule, dataset_id=main, at=60000)
        key = current_version(db, first).market_identity["atr_dependency"]["dataset_id"]
        assert key == current_version(db, second).market_identity["atr_dependency"]["dataset_id"]
        db.get(ProviderDataset, main).latest_at = 180000
    calls = []
    monkeypatch.setattr(provider_service, "now_ms", lambda: 180000)
    monkeypatch.setattr(provider_cache, "read", lambda meta, frame, *args, **kwargs: calls.append(frame))
    provider_service.realtime_step("binance")
    assert calls == ["D1"], "ATR demand must run when the primary dataset is already fresh"
    monkeypatch.setattr(provider_service, "now_ms", lambda: 200 * 86400000)
    provider_service.cleanup()
    with database.begin() as db:
        assert db.get(ProviderDataset, key) is not None
        assert db.get(ProviderDataset, main) is not None


def test_smaller_atr_timeframe_is_fixed_through_evaluation_bucket(database):
    with database.begin() as db:
        seed(db, [(100, 4)] * 11 + [(104, 20)] * 4)
        for start in (300000, 600000):
            db.add(Bar(instrument_id="BTCUSDT", timeframe="M5", start=start, end=start + 300000,
                open=D(100), high=D(104), low=D(100), close=D(100 if start == 300000 else 104),
                complete=True, observed_at=start + 300000))
        ident = create(db, "smaller-atr", config(timeframe="M5"), at=600000).id
        assert len(evaluate(db, ident, now=900001)) == 1
        offset = db.scalar(select(SignalRow)).evidence["observation"]["offset"]
        assert offset["reference_start"] == 540000 and offset["reference_end"] == 600000
        assert offset["atr"] == "4.0"


def test_missing_latest_atr_waits_then_recovers_without_gap_signal(database):
    with database.begin() as db:
        seed(db, [(100, 4)] * 15)
        for start, price in ((300000, 100), (600000, 104)):
            db.add(Bar(instrument_id="BTCUSDT", timeframe="M5", start=start, end=start + 300000,
                open=D(price), high=D(price), low=D(price), close=D(price), complete=True,
                observed_at=start + 300000))
        ident = create(db, "atr-gap", config(timeframe="M5"), at=300000).id
        evaluate(db, ident, now=600001)
        db.delete(db.scalar(select(Bar).where(Bar.start == 540000, Bar.timeframe == "M1",
                                            Bar.instrument_id == "BTCUSDT")))
        db.flush()
        evaluate(db, ident, now=900001)
        assert db.get(ChartAlert, ident).runtime["offset_recovering"]
    with database.begin() as db:
        db.add(Bar(instrument_id="BTCUSDT", timeframe="M1", start=540000, end=600000,
            open=D(100), high=D(102), low=D(98), close=D(100), complete=True,
            observed_at=600000, received_at=600000))
        assert evaluate(db, ident, now=900002) == []
        row = db.get(ChartAlert, ident)
        assert row.count == 0 and D(row.state["left"]) == 104


def test_composite_atr_uses_fixed_revision_and_real_transaction(database, monkeypatch):
    from test_composite_alerts import append, armed, settle

    ident, _, revision, seam, stamp = armed(database, monkeypatch, seam_policy="accept_raw",
        condition={"relation": "cross_up", "right": {"kind": "constant", "value": "1.11"},
                   "offset": {"timeframe": "M1", "period": 2, "multiplier": "0.2"}})
    assert settle(database, ident, stamp) == []
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        assert alert.health == "ready", alert.health_reason
        assert alert.runtime["offset"]["dependency"]["composite_revision_id"] == revision
        assert alert.runtime["offset"]["reference_end"] == seam + 540000
    next_time = seam + 660010
    append(database, revision, seam + 600000, "1.119", next_time)
    events = settle(database, ident, next_time)
    # Derived-job waiting on continuous confirmed input must not discard the
    # first price sample of the next period.
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        assert alert.health == "ready", alert.health_reason
        assert len(events) == 1
        assert alert.runtime["offset"]["reference_end"] == seam + 600000


def test_h4_d1_shared_close_uses_old_day_then_rebases_on_first_new_price(database):
    day, h4 = 86400000, 14400000
    with database.begin() as db:
        for index, width in enumerate((4, 4, 4, 20)):
            db.add(Bar(instrument_id="BTCUSDT", timeframe="D1", start=index * day,
                end=(index + 1) * day, open=D(100), high=D(100 + width / 2), low=D(100 - width / 2),
                close=D(100), complete=True, observed_at=(index + 1) * day, received_at=(index + 1) * day))
        for start, price in ((4 * day - 2 * h4, 100), (4 * day - h4, 103), (4 * day, 107)):
            db.add(Bar(instrument_id="BTCUSDT", timeframe="H4", start=start, end=start + h4,
                open=D(price), high=D(price), low=D(price), close=D(price), complete=True,
                observed_at=start + h4))
        rule = config(timeframe="H4", condition=condition(offset={
            "timeframe": "D1", "period": 2, "multiplier": "0.5"}).model_dump(mode="json"))
        ident = create(db, "h4-d1-boundary", rule, at=4 * day - h4).id
        assert len(evaluate(db, ident, now=4 * day + h4 + 1)) == 2
        events = list(db.scalars(select(SignalRow).order_by(SignalRow.occurred_at)))
        offsets = [event.evidence["observation"]["offset"] for event in events]
        assert offsets[0]["reference_end"] == 3 * day
        assert offsets[0]["atr"] == "4.0" and D(offsets[0]["threshold"]) == 102
        assert offsets[1]["reference_end"] == 4 * day
        assert offsets[1]["atr"] == "12.0" and D(offsets[1]["threshold"]) == 106
        assert D(offsets[1]["baseline_translation"]["translated_right"]) == 106


def test_restart_checkpoint_matches_talib_and_consumes_only_new_input():
    from alerts.chart_alert_offsets import ordinary_values
    from alerts.chart_alert_worker import fingerprint
    from alerts.chart_indicators import calculate

    rows = [{"start": i * 60000, "end": (i + 1) * 60000, "open": "100",
        "high": str(102 + i % 7), "low": str(98 - i % 5), "close": str(100 + i % 3),
        "complete": True} for i in range(180)]
    spec = AtrOffset(timeframe="M1", period=14)
    first, checkpoint = ordinary_values(rows[:120], spec, {}, fingerprint)
    resumed, state = ordinary_values(rows[119:], spec, checkpoint, fingerprint)
    expected = calculate(rows, spec.spec())["series"][0]["values"]
    assert first["7140000"] == pytest.approx(expected[119]["value"])
    assert resumed["10740000"] == pytest.approx(expected[-1]["value"])
    assert state["state"]["state"]["n"] == 180
    assert len(state["values"]) == 1


def test_independent_atr_revision_blocks_while_main_input_is_unchanged(database):
    with database.begin() as db:
        seed(db, [(100, 4)] * 15)
        db.add(Bar(instrument_id="BTCUSDT", timeframe="M5", start=300000, end=600000,
            open=D(100), high=D(100), low=D(100), close=D(100), complete=True, observed_at=600000))
        ident = create(db, "atr-only-correction", config(timeframe="M5"), at=300000).id
        evaluate(db, ident, now=600001)
    with database.begin() as db:
        bar = db.scalar(select(Bar).where(Bar.timeframe == "M1", Bar.start == 60000))
        bar.high += 1
        bar.revision += 1
        db.flush()
        assert evaluate(db, ident, now=600002) == []
        alert = db.get(ChartAlert, ident)
        assert alert.health == "blocked" and "ATR" in alert.health_reason


@pytest.mark.parametrize("kind", ["provider", "published"])
def test_atr_volume_refresh_does_not_block_but_price_revision_does(database, kind):
    from alerts import provider_cache
    from alerts.storage import ChartPublication, ChartPublishedBar, ProviderBar

    frame = "M1"
    key = provider_cache.ensure({"id": "BTCUSDT", "source": "binance", "symbol": "BTCUSDT",
        "basis": "last", "calendar": "utc0", "precision": 2}, frame) if kind == "provider" else None
    with database.begin() as db:
        seed(db, [(100, 4)] * 15)
        if kind == "published":
            db.add(ChartPublication(instrument_id="BTCUSDT", timeframe=frame,
                start=0, end=900000, complete_count=15, initialized=True))
        for i in range(15):
            payload = dict(start=i * 60000, end=(i + 1) * 60000,
                open="100", high="102", low="98", close="100", complete=True,
                volume="1", observed_at=(i + 1) * 60000)
            if key:
                db.add(ProviderBar(dataset_id=key, start=payload["start"], chart_time=payload["start"],
                    complete=True, payload=payload, observed_at=payload["end"]))
            else:
                db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe=frame,
                    start=payload["start"], end=payload["end"], complete=True, payload=payload))
        ident = create(db, "atr-volume-" + kind, config(series_kind="provider" if key else "managed",
            published=not key), dataset_id=key, at=780000).id
        assert evaluate(db, ident, now=900001) == []
        assert db.get(ChartAlert, ident).health == "ready"
    with database.begin() as db:
        row = db.get(ProviderBar, (key, 60000)) if key else db.get(ChartPublishedBar, ("BTCUSDT", frame, 60000))
        row.payload = {**row.payload, "volume": "7", "volume_complete": True}
        row.revision += 1
        db.flush()
        assert evaluate(db, ident, now=900002) == []
        assert db.get(ChartAlert, ident).health == "ready", db.get(ChartAlert, ident).health_reason
    with database.begin() as db:
        row = db.get(ProviderBar, (key, 60000)) if key else db.get(ChartPublishedBar, ("BTCUSDT", frame, 60000))
        row.payload = {**row.payload, "high": "103"}
        row.revision += 1
        db.flush()
        assert evaluate(db, ident, now=900003) == []
        assert db.get(ChartAlert, ident).health == "blocked"


@pytest.mark.parametrize("published", [False, True])
def test_atr_forward_initialization_persists_fixed_origin_across_bounded_pages(database, monkeypatch, published):
    from alerts import chart_alert_worker as worker
    from alerts.storage import ChartPublication, ChartPublishedBar
    monkeypatch.setattr(worker, "ATR_PAGE_ROWS", 4, raising=False)
    with database.begin() as db:
        seed(db, [(100, 4)] * 15)
        if published:
            db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=0,
                end=900000, complete_count=15, initialized=True))
            for i in range(15):
                payload = dict(start=i * 60000, end=(i + 1) * 60000, open="100", high="102", low="98",
                    close="100", complete=True, observed_at=(i + 1) * 60000)
                db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=payload["start"],
                    end=payload["end"], complete=True, payload=payload))
        ident = create(db, "paged-atr", config(published=published), at=780000).id
        assert evaluate(db, ident, now=900001) == []
        alert = db.get(ChartAlert, ident)
        assert alert.health == "warming"
        assert alert.runtime["atr_calculation"]["end"] == 240000
        assert alert.runtime["atr_calculation"]["origin"] == 0
    for attempt in range(6):
        with database.begin() as db:
            assert evaluate(db, ident, now=900002 + attempt) == []
            alert = db.get(ChartAlert, ident)
            assert alert.count == 0
            if alert.health == "ready":
                assert alert.runtime["offset"]["atr"] == "4.0"
                assert alert.runtime["atr_calculation"]["state"]["state"]["n"] == 14
                break
    else:
        pytest.fail("fixed-origin initialization did not finish")


def test_composite_cross_frame_atr_watermark_seam_and_price_correction(database, monkeypatch):
    from alerts.storage import CompositeAggregateTask
    from test_composite_aggregates import drain
    from test_composite_alerts import append, live, settle
    from test_composite_alerts import config as composite_config
    from test_composite_chart import populated
    from test_fixed_indicators import add_tail
    from test_market_contracts import minute

    composite, revision, seam = populated(database, monkeypatch)
    add_tail(database, revision, [minute(seam + i * 60000, volume="3") for i in range(10, 30)],
             observed_at=seam + 1800000)
    drain(revision, "M1")
    drain(revision, "M5")
    stamp = seam + 1800010
    live(database, revision, stamp, seam + 1800000)
    offset = {"timeframe": "M5", "period": 2, "multiplier": "0.2"}
    condition = {"relation": "cross_up", "right": {"kind": "constant", "value": "1.11"}, "offset": offset}
    with database.begin() as db:
        ident = create(db, "composite-cross-frame", composite_config(composite,
            condition=condition, seam_policy="accept_raw"), at=stamp).id
        rejected = create(db, "composite-seam-rejected", composite_config(composite,
            condition=condition, seam_policy="reject"), at=stamp).id
    assert settle(database, ident, stamp) == []
    assert settle(database, rejected, stamp) == []
    with database.begin() as db:
        row = db.get(ChartAlert, ident)
        assert row.health == "ready", row.health_reason
        assert row.runtime["offset"]["reference_end"] == seam + 1500000
        # This fixture has a historical gap before the seam; the state engine
        # initializes after it and no longer depends on a cross-seam close.
        assert db.get(ChartAlert, rejected).health == "ready"
    append(database, revision, seam + 1800000, "1.119", seam + 1860010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 1860010) == []
        assert db.get(ChartAlert, ident).health == "warming"
        assert "聚合水位" in db.get(ChartAlert, ident).health_reason
    drain(revision, "M5")
    assert settle(database, ident, seam + 1860010) == []  # lost-input interval recovers safely
    for at, close in ((1860000, "1.10"), (1920000, "1.119")):
        append(database, revision, seam + at, close, seam + at + 60010)
        drain(revision, "M5")
        events = settle(database, ident, seam + at + 60010)
    assert len(events) == 1
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["offset"]["reference_end"] == seam + 1800000
        snapshot = db.scalar(select(SignalRow)).evidence
    add_tail(database, revision, [minute(seam + 60000, volume="3", high="1.14")], observed_at=seam + 1980010)
    drain(revision, "M1")
    drain(revision, "M5")
    assert settle(database, ident, seam + 1980020) == []
    with database.begin() as db:
        assert db.get(ChartAlert, ident).count == 1
        assert db.scalar(select(SignalRow)).evidence == snapshot
        assert db.get(CompositeAggregateTask, (revision, "M5")).applied_input_revision > 1


@pytest.mark.parametrize("target,expected", [
    ({"kind": "constant", "value": "100"}, "100"),
    ({"kind": "line", "line": {"kind": "horizontal_line",
      "points": [{"time": 0, "index": 0, "price": "100"}]}}, "100"),
    ({"kind": "line", "line": {"kind": "trend_line", "scale": "linear", "extend_right": True,
      "points": [{"time": 0, "index": 0, "price": "104"},
                 {"time": 120000, "index": 2, "price": "102"}]}}, "100"),
    ({"kind": "line", "line": {"kind": "trend_line", "scale": "log", "extend_right": True,
      "points": [{"time": 0, "index": 0, "price": "100"},
                 {"time": 120000, "index": 2, "price": "100"}]}}, "100"),
    ({"kind": "indicator", "indicator": {"name": "SMA", "params": {"period": 2}}}, "103"),
])
def test_worker_targets_preserve_geometry_and_indicator_semantics(database, target, expected):
    with database.begin() as db:
        seed(db, [(100, 4), (100, 4), (100, 4), (100, 4), (106, 4)])
        rule = config(condition=condition(right=target).model_dump(mode="json"))
        ident = create(db, "atr-target", rule, at=180000).id
        assert len(evaluate(db, ident, now=300001)) == 1
        details = db.scalar(select(SignalRow)).evidence["observation"]["offset"]
        assert D(details["base_target"]) == pytest.approx(D(expected))
        assert D(details["threshold"]) == pytest.approx(D(expected) + D(2))


@pytest.mark.parametrize("relation,prices", [
    ("cross_up", [100, 100, 100, 102, 104]),
    ("cross_down", [100, 100, 100, 98, 96]),
    ("above", [100, 100, 100, 102, 104]),
    ("below", [100, 100, 100, 98, 96]),
])
def test_all_offset_directions_remain_strict_at_equality(database, relation, prices):
    with database.begin() as db:
        seed(db, [(price, 4) for price in prices])
        ident = create(db, "atr-strict", config(condition=condition(relation=relation).model_dump(mode="json")), at=180000).id
        assert evaluate(db, ident, now=240001) == []
        assert db.get(ChartAlert, ident).count == 0
        assert len(evaluate(db, ident, now=300001)) == 1


def test_atr_refresh_keeps_original_moving_target_cross_semantics():
    # The price stays still while the original descending line crosses it;
    # offset translation must not introduce an extra price-momentum filter.
    before = EvaluationState(1, "101", "102", 0)
    translated, _ = rebase(before, {"signed_offset": "2"}, {"signed_offset": "1"})
    _, event = advance(condition(), translated, Observation("line moved", 2, 2, D(101), D(100)), 3)
    assert event


def test_intrabar_h4_d1_reference_stays_fixed_and_delayed_confirmation_recovers(database):
    day, h4 = 86400000, 14400000
    with database.begin() as db:
        for i in range(4):
            db.add(Bar(instrument_id="BTCUSDT", timeframe="D1", start=i * day, end=(i + 1) * day,
                open=D(100), high=D(102), low=D(98), close=D(100), complete=i < 3,
                observed_at=3 * day + 1000 if i == 2 else (i + 1) * day,
                received_at=3 * day + 1000 if i == 2 else (i + 1) * day))
        db.add(Bar(instrument_id="BTCUSDT", timeframe="H4", start=3 * day, end=3 * day + h4,
            open=D(100), high=D(104), low=D(100), close=D(104), complete=False,
            observed_at=3 * day + 500))
        rule = config(timeframe="H4", mode="intrabar", condition=condition(offset={
            "timeframe": "D1", "period": 2, "multiplier": "0.5"}).model_dump(mode="json"))
        ident = create(db, "intrabar-confirm", rule, at=3 * day).id
        assert evaluate(db, ident, now=3 * day + 501) == []
        assert "确认晚于" in db.get(ChartAlert, ident).health_reason
    with database.begin() as db:
        current = db.scalar(select(Bar).where(Bar.instrument_id == "BTCUSDT", Bar.timeframe == "H4", Bar.start == 3 * day))
        current.observed_at = 3 * day + 2000
        assert evaluate(db, ident, now=3 * day + 2001) == []
        alert = db.get(ChartAlert, ident)
        assert alert.count == 0 and D(alert.state["left"]) == 104
        assert alert.runtime["offset"]["reference_end"] == 3 * day
        # Current D1 extremes must never participate in this H4 threshold.
        forming = db.scalar(select(Bar).where(Bar.instrument_id == "BTCUSDT", Bar.timeframe == "D1", Bar.start == 3 * day))
        forming.high = D(10000)
        current.close = D(100)
        current.observed_at = 3 * day + 3000
        assert evaluate(db, ident, now=3 * day + 3001) == []
        assert db.get(ChartAlert, ident).runtime["offset"]["atr"] == "4.0"
    with database.begin() as db:
        current = db.scalar(select(Bar).where(Bar.instrument_id == "BTCUSDT", Bar.timeframe == "H4", Bar.start == 3 * day))
        current.close = D(104)
        current.observed_at = 3 * day + 4000
        assert len(evaluate(db, ident, now=3 * day + 4001)) == 1
        offset = db.scalar(select(SignalRow)).evidence["observation"]["offset"]
        assert offset["atr"] == "4.0" and D(offset["threshold"]) == 102


def test_provider_geometry_request_uses_main_dataset_without_offset_contract(database, monkeypatch):
    from alerts import api as api_module
    from alerts.provider_cache import ensure
    from alerts.storage import ProviderBar
    from fastapi.testclient import TestClient
    from test_chart_alert_api import login

    meta = {"id": "BTCUSDT", "source": "binance", "symbol": "BTCUSDT",
        "basis": "last", "calendar": "utc0", "precision": 2}
    key = ensure(meta, "M1")
    with database.begin() as db:
        db.add(ProviderBar(dataset_id=key, start=60000, chart_time=60000,
            complete=True, observed_at=120000, payload=dict(start=60000, end=120000,
                chart_time=60000, open="100", high="102", low="98", close="100", complete=True)))
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        result = client.post("/api/chart-alerts/geometry", json=dict(instrument="BTCUSDT", source="binance",
            series_kind="provider", timeframe="M1", kind="horizontal_line", scale="linear",
            points=[dict(time=60000, price="100")]))
        assert result.status_code == 200, result.text
        assert result.json()["mapping_version"] == "bar-index-v1"


@pytest.mark.parametrize("policy", ["reject", "accept_raw"])
def test_composite_cross_frame_atr_continuous_seam_policy(database, monkeypatch, policy):
    from alerts.history_artifacts import artifact_tick
    from alerts.history_versions import create_version, import_page
    from test_composite_aggregates import drain
    from test_composite_alerts import armed, settle
    from test_history_versions import Adapter
    from test_market_contracts import batch, identity, minute

    def dense_history(factory):
        end = 172920000
        with factory.begin() as db:
            version = create_version(db, identity().key, 0, end)
        import_page(Adapter([batch(window_end=end, checkpoint=end,
            rows=tuple(minute(at) for at in range(0, end, 60000)))]), version_id=version)
        while artifact_tick(version):
            pass
        return version

    monkeypatch.setattr("test_composite_preparation.publish", dense_history)
    ident, _, revision, _, stamp = armed(database, monkeypatch, seam_policy=policy,
        condition={"relation": "cross_up", "right": {"kind": "constant", "value": "1.11"},
                   "offset": {"timeframe": "M5", "period": 2, "multiplier": "0.2"}})
    drain(revision, "M5")
    assert settle(database, ident, stamp) == []
    with database.begin() as db:
        row = db.get(ChartAlert, ident)
        if policy == "reject":
            assert row.health == "warming" and "ATR 依赖包含原价接缝" in row.health_reason
        else:
            assert row.health == "ready", row.health_reason
            assert row.runtime["offset"]["dependency"]["dependency"]["seam_dependency"]
        assert row.count == 0


def test_unchanged_provider_overlap_does_not_rewrite_first_price_confirmation(database):
    from alerts.provider_cache import ensure
    from alerts.storage import ProviderBar
    key = ensure({"id": "BTCUSDT", "source": "binance", "symbol": "BTCUSDT",
        "basis": "last", "calendar": "utc0", "precision": 2}, "M1")
    with database.begin() as db:
        for i in range(6):
            start, end = i * 60000, (i + 1) * 60000
            close = "104" if i == 5 else "100"
            db.add(ProviderBar(dataset_id=key, start=start, chart_time=start, complete=True,
                observed_at=500000, changed_at=end, revision=1,
                payload=dict(start=start, end=end, open="100", high="104", low="98", close=close, complete=True)))
        ident = create(db, "first-confirmation", config(series_kind="provider"), dataset_id=key, at=240000).id
        assert len(evaluate(db, ident, now=500001)) == 1
        event = db.scalar(select(SignalRow))
        assert event.evidence["observation"]["offset"]["confirmed_at"] == 300000


def test_managed_ny17_dst_weekend_uses_confirmed_friday_atr(database):
    from datetime import datetime

    from alerts.storage import Instrument

    opened = int(datetime.fromisoformat("2026-11-01T22:00:00+00:00").timestamp() * 1000)
    friday_end = int(datetime.fromisoformat("2026-10-30T21:00:00+00:00").timestamp() * 1000)
    with database.begin() as db:
        instrument = db.get(Instrument, "EURUSD")
        cursor = opened
        for _ in range(5):
            left, right = reference_bar(cursor, "D1", {"calendar": "ny17"}, "EURUSD")
            db.add(Bar(instrument_id="EURUSD", timeframe="D1", start=left, end=right,
                open=D("1.10"), high=D("1.102"), low=D("1.098"), close=D("1.10"),
                complete=True, observed_at=right, received_at=right))
            cursor = left
        end = period(opened, "H4", "ny17")[1]
        db.add(Bar(instrument_id="EURUSD", timeframe="H4", start=opened, end=end,
            open=D("1.10"), high=D("1.101"), low=D("1.10"), close=D("1.10"),
            complete=False, observed_at=opened + 500))
        rule = config(instrument="EURUSD", source=instrument.source, timeframe="H4", mode="intrabar",
            condition={"relation": "cross_up", "right": {"kind": "constant", "value": "1.10"},
                "offset": {"timeframe": "D1", "period": 2, "multiplier": "0.2"}})
        ident = create(db, "ny17-confirmed", rule, at=opened).id
        assert evaluate(db, ident, now=opened + 501) == []
        assert db.get(ChartAlert, ident).runtime["offset"]["reference_end"] == friday_end
    with database.begin() as db:
        current = db.scalar(select(Bar).where(Bar.instrument_id == "EURUSD", Bar.timeframe == "H4"))
        current.close, current.observed_at = D("1.101"), opened + 1000
        assert len(evaluate(db, ident, now=opened + 1001)) == 1
        offset = db.scalar(select(SignalRow)).evidence["observation"]["offset"]
        assert offset["reference_end"] == friday_end
        assert D(offset["threshold"]) == pytest.approx(D("1.1008"))


@pytest.mark.parametrize("published", [False, True])
def test_late_atr_seed_cannot_generate_past_event_and_recovers(database, published):
    from alerts.storage import ChartPublication, ChartPublishedBar
    with database.begin() as db:
        seed(db, [(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)])
        late = db.scalar(select(Bar).where(Bar.timeframe == "M1", Bar.start == 60000,
                                          Bar.instrument_id == "BTCUSDT"))
        late.received_at = late.observed_at = 300001
        if published:
            db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=0,
                end=300000, complete_count=5, initialized=True))
            for bar in db.scalars(select(Bar).where(Bar.instrument_id == "BTCUSDT", Bar.timeframe == "M1")):
                payload = dict(start=bar.start, end=bar.end, open=str(bar.open), high=str(bar.high),
                    low=str(bar.low), close=str(bar.close), complete=True,
                    observed_at=bar.observed_at, confirmed_at=bar.received_at)
                db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=bar.start,
                    end=bar.end, complete=True, payload=payload))
        ident = create(db, "late-atr-seed", config(published=published), at=180000).id
        assert evaluate(db, ident, now=300002) == []
        assert db.get(ChartAlert, ident).runtime["offset_recovering"]
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 0
    with database.begin() as db:
        for start, price in ((300000, 100), (360000, 104)):
            db.add(Bar(instrument_id="BTCUSDT", timeframe="M1", start=start, end=start + 60000,
                open=D(price), close=D(price), high=D(price) + 2, low=D(price) - 2,
                complete=True, observed_at=start + 60000, received_at=start + 60000))
            if published:
                payload = dict(start=start, end=start + 60000, open=str(price), high=str(price + 2),
                    low=str(price - 2), close=str(price), complete=True,
                    observed_at=start + 60000, confirmed_at=start + 60000)
                db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=start,
                    end=start + 60000, complete=True, payload=payload))
        if published:
            db.get(ChartPublication, ("BTCUSDT", "M1")).end = 420000
        # First fresh sample after late input establishes the recovery baseline.
        assert evaluate(db, ident, now=360001) == []
        assert D(db.get(ChartAlert, ident).state["left"]) == 100
    with database.begin() as db:
        assert len(evaluate(db, ident, now=420001)) == 1
        assert db.get(ChartAlert, ident).count == 1


@pytest.mark.parametrize("published", [False, True])
def test_managed_unchanged_reference_reread_keeps_first_confirmation(database, monkeypatch, published):
    from alerts.bar_batch import write_bars
    from alerts.managed_dataset import publish_corrections
    from alerts.storage import ChartPublication, ChartPublishedBar, Instrument
    with database.begin() as db:
        seed(db, [(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)])
        if published:
            db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=0,
                end=300000, complete_count=5, initialized=True))
            for bar in db.scalars(select(Bar).where(Bar.instrument_id == "BTCUSDT", Bar.timeframe == "M1")):
                payload = dict(start=bar.start, end=bar.end, open=str(bar.open), high=str(bar.high),
                    low=str(bar.low), close=str(bar.close), complete=True,
                    observed_at=bar.observed_at, confirmed_at=bar.received_at)
                db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=bar.start,
                    end=bar.end, complete=True, payload=payload))
        ident = create(db, "managed-reference-reread", config(published=published), at=180000).id
        assert evaluate(db, ident, now=240001) == []
        ref = db.scalar(select(Bar).where(Bar.timeframe == "M1", Bar.start == 180000,
                                         Bar.instrument_id == "BTCUSDT"))
        monkeypatch.setattr("alerts.bar_batch.now_ms", lambda: 300001)
        write_bars(db, "BTCUSDT", "M1", [ref.candle()], observed_at=300001, observation_only=True)
        assert ref.received_at == 240000 and ref.observed_at == 300001
        if published:
            publish_corrections(db, db.get(Instrument, "BTCUSDT"), db.get(ChartPublication, ("BTCUSDT", "M1")),
                                "M1", 0, 300000, [], 300002)
            assert db.get(ChartPublishedBar, ("BTCUSDT", "M1", 180000)).payload["confirmed_at"] == 240000
        assert len(evaluate(db, ident, now=300002)) == 1
        assert db.get(ChartAlert, ident).health == "ready"


@pytest.mark.parametrize("change", ["observation", "volume", "representation", "price"])
def test_provider_reference_metadata_refresh_keeps_crossing(database, monkeypatch, change):
    from alerts import provider_cache
    from alerts.storage import ProviderBar, ProviderDataset
    key = provider_cache.ensure({"id": "BTCUSDT", "source": "binance", "symbol": "BTCUSDT",
        "basis": "last", "calendar": "utc0", "precision": 2}, "M1")
    with database.begin() as db:
        for i, (price, width) in enumerate([(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)]):
            start, end = i * 60000, (i + 1) * 60000
            payload = dict(start=start, end=end, chart_time=start, open=str(price), close=str(price),
                high=str(price + width / 2), low=str(price - width / 2), complete=True, volume="1")
            db.add(ProviderBar(dataset_id=key, start=start, chart_time=start, complete=True,
                payload=payload, observed_at=end, changed_at=end))
        ident = create(db, "provider-reference-refresh", config(series_kind="provider"), dataset_id=key, at=180000).id
        tail = db.get(ProviderBar, (key, 240000))
        final_payload = dict(tail.payload)
        db.delete(tail)
        db.flush()
        assert evaluate(db, ident, now=240001) == []
        assert db.get(ChartAlert, ident).runtime["offset"]["reference_start"] == 120000
        db.add(ProviderBar(dataset_id=key, start=240000, chart_time=240000, complete=True,
            payload=final_payload, observed_at=300000, changed_at=300000))
        payload = dict(db.get(ProviderBar, (key, 180000)).payload)
        if change == "volume":
            payload["volume"] = "7"
        elif change == "representation":
            payload["high"] = "102.000"
        elif change == "price":
            payload["high"] = "103"
        dataset = db.get(ProviderDataset, key)
        dataset.lease_token, dataset.lease_until = "refresh", 900000
        generation = dataset.generation
    monkeypatch.setattr(provider_cache, "now_ms", lambda: 300001)
    provider_cache.commit_page(key, ("refresh", generation), {"bars": [payload], "history_boundary": False},
                              before=240000, observed_at=300001)
    with database.begin() as db:
        reference = db.get(ProviderBar, (key, 180000))
        assert reference.price_confirmed_at == (300001 if change == "price" else 240000)
        if change in ("price", "representation"):
            assert evaluate(db, ident, now=300002) == []
            # Main-series revision policy is unchanged by the ATR fix.
            assert db.get(ChartAlert, ident).health == "blocked"
            return
        assert len(evaluate(db, ident, now=300002)) == 1
        event = db.scalar(select(SignalRow))
        assert event.evidence["observation"]["offset"]["confirmed_at"] == 240000


@pytest.mark.parametrize("paged", [False, True])
def test_atr_checkpoint_retains_seed_confirmation_watermark(database, monkeypatch, paged):
    from alerts import chart_alert_worker as worker
    if paged:
        monkeypatch.setattr(worker, "ATR_PAGE_ROWS", 4)
    with database.begin() as db:
        seed(db, [(100, 4)] * 15)
        late = db.scalar(select(Bar).where(Bar.timeframe == "M1", Bar.start == 60000,
                                          Bar.instrument_id == "BTCUSDT"))
        late.received_at = late.observed_at = 900001
        ident = create(db, "checkpoint-confirmation", config(), at=780000).id
    for attempt in range(6):
        with database.begin() as db:
            assert evaluate(db, ident, now=900002 + attempt) == []
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["offset_recovering"] and alert.count == 0
        # Even after paging and new evaluator calls, old observations are unsafe.
        db.add(Bar(instrument_id="BTCUSDT", timeframe="M1", start=900000, end=960000,
            open=D(100), high=D(102), low=D(98), close=D(100), complete=True,
            observed_at=960000, received_at=960000))
        assert evaluate(db, ident, now=960001) == []
        alert = db.get(ChartAlert, ident)
        assert alert.state["sequence"] == 960000 and alert.health == "ready"
        assert alert.runtime["atr_calculation"]["confirmation_watermark"] == 900001
        assert alert.runtime["offset"]["confirmation_watermark"] == 900001


def test_legacy_atr_checkpoint_rebuilds_watermark_without_replaying_events(database):
    with database.begin() as db:
        seed(db, [(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)])
        ident = create(db, "legacy-watermark", config(), at=180000).id
        assert len(evaluate(db, ident, now=300001)) == 1
        alert = db.get(ChartAlert, ident)
        runtime = dict(alert.runtime)
        calculated = dict(runtime["atr_calculation"])
        calculated.pop("confirmation_watermark")
        runtime["atr_calculation"] = calculated
        alert.runtime = runtime
    with database.begin() as db:
        assert evaluate(db, ident, now=300002) == []
        db.add(Bar(instrument_id="BTCUSDT", timeframe="M1", start=300000, end=360000,
            open=D(100), high=D(102), low=D(98), close=D(100), complete=True,
            observed_at=360000, received_at=360000))
        assert evaluate(db, ident, now=360001) == []
        alert = db.get(ChartAlert, ident)
        assert alert.count == 1 and alert.runtime["atr_calculation"]["confirmation_watermark"] == 300000
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


@pytest.mark.parametrize("confirmation_delay", [0, 2])
@pytest.mark.parametrize("late_seed", [False, True])
def test_composite_atr_input_must_be_known_at_quote_then_recovers(database, monkeypatch, confirmation_delay, late_seed):
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    from alerts.market_contracts import DatasetIdentity
    from alerts.storage import (
        CompositePreparation,
        CompositeRevision,
        MarketDataset,
        RealtimeMapping,
    )
    from test_composite_aggregates import drain as aggregate
    from test_composite_alerts import armed, forming, settle
    from test_market_contracts import batch, minute

    ident, _, revision, seam, _ = armed(database, monkeypatch, mode="intrabar", seam_policy="accept_raw",
        condition={"relation": "cross_up", "right": {"kind": "constant", "value": "1.11"},
                   "offset": {"timeframe": "M1", "period": 2, "multiplier": "0.2"}})
    forming(database, revision, seam + 600000, seam + 659995, price="1.11")
    assert settle(database, ident, seam + 659995) == []
    with database.begin() as db:
        rev = db.get(CompositeRevision, revision)
        target = db.get(MarketDataset, db.get(RealtimeMapping, rev.mapping_id).target_dataset_id)
        input_start = seam + 480000 if late_seed else seam + 600000
        input_rows = (minute(input_start, volume="3", high="1.121"), minute(seam + 600000, volume="3")) if late_seed else (minute(input_start, volume="3"),)
        source = batch(identity=DatasetIdentity.model_validate(target.identity),
            window_start=input_start, window_end=seam + 660000, checkpoint=seam + 660000,
            observed_at=seam + 660000 + confirmation_delay, volume_kind="price_count", volume_unit="quotes",
            rows=input_rows)
        apply_minutes(db, record(db, source))
    aggregate(revision, "M1")
    forming(database, revision, seam + 660000, seam + 660001, price="1.119")
    events = settle(database, ident, seam + 660003)
    if not confirmation_delay:
        if late_seed:
            assert events == []  # A changed historical seed safely rebaselines.
        else:
            assert len(events) == 1
        return
    assert events == []
    with database.begin() as db:
        assert db.get(ChartAlert, ident).runtime["recovering"]
    # After availability, first valid quote establishes a safe baseline.
    forming(database, revision, seam + 660000, seam + 660004, price="1.119")
    assert settle(database, ident, seam + 660004) == []
    with database.begin() as db:
        runtime = db.get(ChartAlert, ident).runtime
        cached = runtime["atr_confirmation"]
        actual = db.get(CompositePreparation, revision).input_revision
        # A corrected historical source was included in the exact revision proof.
        assert cached["key"][1] == actual and cached["watermark"] == seam + 660002
    forming(database, revision, seam + 660000, seam + 660005, price="1.11")
    assert settle(database, ident, seam + 660005) == []
    forming(database, revision, seam + 660000, seam + 660006, price="1.119")
    assert len(settle(database, ident, seam + 660006)) == 1


def test_composite_confirmation_delta_matches_full_fixed_revision(database, monkeypatch):
    from alerts.composite_inputs import confirmation_watermark
    from test_composite_chart import populated
    from test_fixed_indicators import add_tail
    from test_market_contracts import minute

    _, revision, seam = populated(database, monkeypatch)
    with database.begin() as db:
        initial = confirmation_watermark(db, revision, seam, seam + 540000, 1)
        cache = {"key": [revision, 1, seam, seam + 540000], "watermark": initial}
    add_tail(database, revision, [minute(seam + 600000, volume="3")], observed_at=seam + 660000)
    with database.begin() as db:
        assert confirmation_watermark(db, revision, seam, seam + 540000, 2, previous=cache) == initial
        growth = confirmation_watermark(db, revision, seam, seam + 660000, 2, previous=cache)
        assert growth == confirmation_watermark(db, revision, seam, seam + 660000, 2) == seam + 660000
    cache = {"key": [revision, 2, seam, seam + 660000], "watermark": growth}
    add_tail(database, revision, [minute(seam + 60000, volume="3", high="1.14")], observed_at=seam + 670000)
    with database.begin() as db:
        for start, end, value in ((seam, seam + 660000, 3), (seam, seam + 540000, 3),
                                  (seam + 600000, seam + 660000, 3), (seam, seam + 660000, 1)):
            assert confirmation_watermark(db, revision, start, end, value, previous=cache) == confirmation_watermark(
                db, revision, start, end, value)
