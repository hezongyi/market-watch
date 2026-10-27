from datetime import datetime, timedelta

import pytest
from alerts.calendar_profile import normalized_profile
from alerts.domain import Calendar, bucket_bounds, calendar_for, calendar_from, scheduled_open
from alerts.market import ingest
from alerts.market_datasets import register_dataset
from alerts.storage import Audit, Bar
from sqlalchemy import select
from test_live_pricing import running as running
from test_market_contracts import batch, minute
from test_market_datasets import identity


def dt(value):
    return datetime.fromisoformat(value)


def profile(ident=None):
    ident = ident or identity(calendar_version="reviewed-fixture-v1")
    return {"revision": ident.calendar_version, "source_session": {
        **{key: getattr(ident, key) for key in ("source", "channel", "environment",
                                               "account_scope", "provider_symbol")},
        "timezone": "America/New_York", "reviewed_start": "2026-01-01T00:00:00+00:00",
        "reviewed_end": "2027-01-01T00:00:00+00:00",
        "evidence_url": "https://example.test/source-schedule",
        "applicability": "Synthetic applicability fixture; no claim about a real account",
        "weekly_closures": [{"start": day * 1440 + 17 * 60, "end": day * 1440 + 18 * 60 + 4}
                            for day in range(7)]}}


def test_candidate_phase_does_not_certify_missing_minutes_as_closed():
    moment = dt("2026-07-06T21:15:00+00:00")
    candidate = calendar_from("ny17", explicit=True)
    assert not scheduled_open(moment, Calendar.NY17, gold=True)
    assert scheduled_open(moment, candidate, gold=True)
    assert bucket_bounds(moment, "H4", candidate) == bucket_bounds(moment, "H4", Calendar.NY17)
    assert scheduled_open(dt("2026-07-11T12:00:00+00:00"), candidate)


@pytest.mark.parametrize("start", ("2026-03-06T22:00:00+00:00", "2026-03-09T21:00:00+00:00"))
def test_reviewed_local_interiors_follow_dst_and_keep_boundary_minutes(start):
    calendar = calendar_from("ny17", profile(), explicit=True)
    moment = dt(start)
    assert scheduled_open(moment - timedelta(minutes=1), calendar, gold=True)
    assert not scheduled_open(moment, calendar, gold=True)
    assert not scheduled_open(moment + timedelta(minutes=63), calendar, gold=True)
    assert scheduled_open(moment + timedelta(minutes=64), calendar, gold=True)


def test_source_review_has_finite_applicability():
    calendar = calendar_from("ny17", profile(), explicit=True)
    assert scheduled_open(dt("2025-07-06T21:15:00+00:00"), calendar, gold=True)
    assert scheduled_open(dt("2027-07-06T21:15:00+00:00"), calendar, gold=True)
    assert hash(calendar) == hash(calendar_from("ny17", profile(), explicit=True))


def test_registration_binds_session_scope_and_revision_immutably(database):
    ident = identity(calendar_version="reviewed-fixture-v1")
    kwargs = dict(logical_symbol="EURUSD", label="EURUSD", calendar="ny17", precision=5,
                  volume_kind="quantity", volume_unit="source_quantity")
    with database.begin() as db:
        inst = register_dataset(db, ident, **kwargs, calendar_profile=profile(ident))
        assert calendar_for(inst).session.provider_symbol == ident.provider_symbol
        assert register_dataset(db, ident, **kwargs, calendar_profile=profile(ident)).id == inst.id
        with pytest.raises(ValueError, match="metadata"):
            register_dataset(db, ident, **kwargs)
    with database.begin() as db:
        new = identity(calendar_version="wrong-scope-v2")
        data = profile(new)
        data["source_session"]["provider_symbol"] = "XAU/USD"
        with pytest.raises(ValueError, match="applicability"):
            register_dataset(db, new, **kwargs, calendar_profile=data)


def test_malformed_session_rules_are_rejected():
    data = profile()
    data["source_session"]["weekly_closures"][1] = {"start": 1, "end": 2}
    with pytest.raises(ValueError, match="ordered"):
        normalized_profile(data)
    data = profile()
    data["source_session"]["account_scope"] = "private-account"
    with pytest.raises(ValueError, match="fingerprint"):
        normalized_profile(data)


def test_candidate_missing_gold_maintenance_cannot_be_certified_complete(database):
    from alerts.market import aggregate_touched
    from alerts.storage import ms

    start = dt("2026-07-06T21:00:00+00:00")
    ident = identity(provider_symbol="XAU/USD", calendar_version="candidate-gold-v1")
    with database.begin() as db:
        inst = register_dataset(db, ident, logical_symbol="XAUUSD", label="gold", calendar="ny17",
            precision=3, volume_kind="quantity", volume_unit="source_quantity")
        # A fully observed tail cannot prove that the missing hour before it
        # was closed just because the aggregation phase is NY17.
        for index in range(60, 240):
            left = ms(start) + index * 60000
            db.add(Bar(instrument_id=inst.id, timeframe="M1", start=left, end=left + 60000,
                open=100, high=101, low=99, close=100, complete=True))
        db.flush()
        aggregate_touched(db, inst, {start + timedelta(hours=1)},
                          received_at=ms(start + timedelta(hours=4)) + 5000, timeframes=("H4",))
        bar = db.scalar(select(Bar).where(Bar.instrument_id == inst.id, Bar.timeframe == "H4"))
        assert bar is not None and not bar.complete


def test_source_observation_conflicting_with_reviewed_closure_is_preserved(database):
    from alerts.storage import ms

    ident = identity(calendar_version="reviewed-fixture-v1")
    data = profile(ident)
    start = ms(dt("2026-07-06T21:10:00+00:00"))
    data["closures"] = [{"start": "2026-07-06T21:10:00+00:00", "end": "2026-07-06T21:12:00+00:00",
                         "source": "https://example.test/holiday", "reason": "synthetic conflict"}]
    with database.begin() as db:
        inst = register_dataset(db, ident, logical_symbol="EURUSD", label="FX", calendar="ny17",
            precision=5, volume_kind="quantity", volume_unit="source_quantity", calendar_profile=data)
        payload = batch(identity=ident, window_start=start, window_end=start + 120000,
            rows=(minute(start),), observed_at=start + 125000).ingestion_payload()
        ingest(db, inst, payload)
        assert db.scalar(select(Bar).where(Bar.instrument_id == inst.id, Bar.timeframe == "M1")) is not None
        conflict = db.scalar(select(Audit).where(Audit.kind == "source_session_observation_conflict"))
        assert conflict.details["observed_minute_starts"] == [start]


def test_only_account_bound_review_can_certify_live_closed_interior(database, monkeypatch):
    import hashlib

    from alerts import live_pricing as live
    from alerts.config import settings
    from alerts.market_contracts import CandleBatch, DatasetIdentity, RequestResult
    from alerts.storage import ms

    ident = DatasetIdentity(source="oanda", channel="v20", environment="practice",
        provider_symbol="EUR_USD", account_scope="sha256:" + hashlib.sha256(b"fixture-account").hexdigest(),
        basis="bid", calendar_version="reviewed-fixture-v1")
    data = profile(ident)
    monkeypatch.setattr(settings, "oanda_calendar_version", ident.calendar_version)
    monkeypatch.setattr(settings, "oanda_calendar_profiles", {"EUR_USD": data})
    monkeypatch.setattr(settings, "oanda_resident_symbols", "EUR_USD")
    stamp = ms(dt("2026-07-06T21:11:05+00:00"))
    monkeypatch.setattr(live, "now_ms", lambda: stamp)
    live.ensure_catalog([{"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5}], "fixture-account")
    from alerts.realtime_switch import set_enabled
    from alerts.storage import MarketDataset
    with live.transaction() as db:
        dataset = next(row for row in db.scalars(select(MarketDataset))
                       if row.identity.get("provider_symbol") == "EUR_USD")
        set_enabled(db, dataset.instrument_id, True, now=stamp)
    ownership = live.claim("fixture-account")
    identities = live.desired_datasets("fixture-account")
    epoch = live.begin_connection(ownership, identities)
    live.publish_event(ownership, epoch, {"type": "heartbeat", "received_at": stamp,
                       "connection_epoch": epoch}, identities)
    live.commit_confirmation(ownership, epoch, CandleBatch(identity=ident,
        window_start=stamp - 125000, window_end=stamp - 5000, observed_at=stamp,
        rows=(), volume_kind="price_count", volume_unit="quotes", result=RequestResult(status="empty_success")))
    state = live.snapshots()[0]
    assert state["calendar_verified"] and state["recovery_ready"]
    assert state["market_session"] == "closed" and state["quality"] == "market_closed"
    assert not state["candle_ready"] and not state["quote_ready"]
    metric = live.measurements(ident.key)
    assert metric["confirmed_closures"] == 2 and metric["missing"] == 0


def test_global_verified_flag_does_not_substitute_for_session_evidence(running, monkeypatch):
    from alerts import live_pricing as live
    from alerts.config import settings

    monkeypatch.setattr(settings, "oanda_calendar_verified", True)
    assert all(not row["calendar_verified"] for row in live.snapshots(now=125000))


def test_revalidation_retracts_stale_candidate_complete_without_changing_observations(database):
    from alerts.calendar_revalidation import revalidate_page
    from alerts.storage import ChartPublication, ChartPublishedBar, ms

    start = ms(dt("2026-07-06T21:00:00+00:00"))
    ident = identity(calendar_version="old-candidate-v1")
    with database.begin() as db:
        inst = register_dataset(db, ident, logical_symbol="EURUSD", label="FX", calendar="ny17",
            precision=5, volume_kind="quantity", volume_unit="source_quantity")
        inst_id = inst.id
        for frame, left, right in (("M1", start + 60000, start + 120000),
                                   ("H4", start, start + 14400000)):
            db.add(Bar(instrument_id=inst_id, timeframe=frame, start=left, end=right,
                open=100, high=101, low=99, close=100, complete=True))
        db.add(ChartPublication(instrument_id=inst_id, timeframe="H4", start=start,
            end=start + 14400000, complete_count=1))
        db.add(ChartPublishedBar(instrument_id=inst_id, timeframe="H4", start=start,
            end=start + 14400000, complete=True, payload={"complete": True, "close": "100"}))
    assert revalidate_page(inst_id)["retracted"] == 1
    assert revalidate_page(inst_id, published=True)["retracted"] == 1
    assert revalidate_page(inst_id)["examined"] == 0
    with database.begin() as db:
        minute = db.scalar(select(Bar).where(Bar.timeframe == "M1"))
        assert minute.complete and minute.close == 100
        aggregate = db.scalar(select(Bar).where(Bar.timeframe == "H4"))
        assert not aggregate.complete and aggregate.close == 100
        published = db.scalar(select(ChartPublishedBar))
        assert not published.complete and published.payload["close"] == "100"
        assert db.scalar(select(ChartPublication)).complete_count == 0


def test_reviewed_source_gold_week_uses_source_session_instead_of_legacy_closures(database):
    from alerts.chart_data import bounds, chart_rows, expected_days
    from alerts.domain import calendar_for
    from alerts.storage import ms

    ident = identity(provider_symbol="XAU/USD", calendar_version="reviewed-fixture-v1")
    data = profile(ident)
    moment = dt("2026-07-08T12:00:00+00:00")
    with database.begin() as db:
        inst = register_dataset(db, ident, logical_symbol="XAUUSD", label="gold", calendar="ny17",
            precision=3, volume_kind="quantity", volume_unit="source_quantity", calendar_profile=data)
        left, right = bounds(moment, "W1", calendar_for(inst))
        for start in expected_days(left, right, calendar_for(inst), True, ()):
            from alerts.domain import session_bounds
            from alerts.storage import instant

            end = ms(session_bounds(instant(start), calendar_for(inst))[1])
            db.add(Bar(instrument_id=inst.id, timeframe="D1", start=start, end=end,
                open=100, high=101, low=99, close=100, complete=True))
        db.flush()
        rows = chart_rows(db, inst, "W1", ms(right), 1, ms(right) + 5000)
        assert len(rows) == 1 and rows[0]["complete"]
