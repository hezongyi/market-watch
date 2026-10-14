"""Stitch before aggregation, finite missing-minute evidence and fixed input reads."""

from datetime import datetime

import pytest
from alerts.composite_inputs import apply_minutes
from alerts.composite_series import aggregate, period, read_window
from alerts.confirmed_minutes import record
from alerts.market_contracts import DatasetIdentity
from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping
from test_composite_preparation import ready
from test_market_contracts import batch, minute


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def segments():
    return {"history": {"source_id": "dukascopy", "profile": {}, "volume_kind": "quantity",
        "volume_unit": "source_quantity", "input": {"history_version_id": "fixed"}},
        "target": {"source_id": "oanda", "profile": {}, "volume_kind": "price_count",
        "volume_unit": "quotes", "input": {"input_revision": 1}}}


def row(at, source, **changes):
    return {**minute(at, **changes).model_dump(), "source_id": "dukascopy" if source == "history" else "oanda",
            "segment": source, "volume_kind": "quantity" if source == "history" else "price_count",
            "volume_unit": "source_quantity" if source == "history" else "quotes"}


def bars(rows, frame="M5", seam=120000, **changes):
    return aggregate(rows, frame, **{"phase": "utc0", "seam": seam, "segments": segments(),
        "revision_id": "fixed", "input_revision": 1, "now": 300000, "history_start": 0, **changes})


def test_mixed_bucket_retains_raw_price_seam_and_segment_volumes():
    original = [row(0, "history", volume="2"), row(60000, "history", volume="2"),
        row(120000, "target", open="1.2", high="1.3", low="1.19", close="1.25", volume="3"),
        row(180000, "target", volume="3"), row(240000, "target", volume="3")]
    result = bars(original)[0]
    assert result["open"] == "1.10" and result["high"] == "1.3" and result["close"] == "1.11"
    assert result["seam_crossing"] and result["mixed_source"]
    assert result["complete"] and result["source_confirmed"] and result["coverage_complete"]
    assert result["volume"] is None and not result["volume_complete"]
    assert [segment["observed_volume"] for segment in result["segments"]] == ["4", "9"]
    assert original[2]["open"] == "1.2"  # No price offset or adjustment.


def test_time_closed_source_confirmation_and_coverage_are_independent():
    result = bars([row(0, "history"), row(120000, "target")])[0]
    assert result["time_closed"] and result["source_confirmed"]
    assert not result["coverage_complete"] and result["unknown_minutes"] == 3
    assert not result["complete"] and result["volume"] is None
    future = bars([row(at, "target") for at in range(0, 300000, 60000)], seam=0, now=250000)[0]
    assert future["coverage_complete"] and future["source_confirmed"] and not future["time_closed"]
    provisional = bars([row(0, "target", complete=False, volume=None)], frame="M1", seam=0)[0]
    assert provisional["time_closed"] and not provisional["coverage_complete"] and not provisional["source_confirmed"]


def test_only_applicable_segment_closure_certifies_a_missing_minute():
    meta = segments()
    meta["history"]["profile"] = {"revision": "reviewed", "closures": [{
        "start": "1970-01-01T00:01:00Z", "end": "1970-01-01T00:02:00Z",
        "source": "https://example.com/session", "reason": "reviewed suspension"}]}
    original = [row(0, "history"), *(row(at, "target") for at in (120000, 180000, 240000))]
    known = bars(original, segments=meta)[0]
    assert known["coverage_complete"] and known["confirmed_closed_minutes"] == 1
    # Moving the same proof to the wrong source does not certify history closure.
    meta["target"]["profile"], meta["history"]["profile"] = meta["history"]["profile"], {}
    assert not bars(original, segments=meta)[0]["coverage_complete"]
    # Observations in a declared closure are retained and reported as conflicts.
    conflict = bars(original + [], seam=120000, segments=segments())[0]
    assert not conflict["session_conflict"]
    meta = segments()
    meta["history"]["profile"] = {"revision": "conflict", "closures": [{
        "start": "1970-01-01T00:00:00Z", "end": "1970-01-01T00:01:00Z",
        "source": "https://example.com/session", "reason": "reviewed suspension"}]}
    conflict = bars(original, segments=meta)[0]
    assert conflict["session_conflict"] and conflict["open"] == "1.10"


@pytest.mark.parametrize("at,frame,expected", [
    ("2026-03-08T22:00:00+00:00", "D1", ("2026-03-08T21:00:00+00:00", "2026-03-09T21:00:00+00:00")),
    ("2026-11-01T23:00:00+00:00", "H4", ("2026-11-01T22:00:00+00:00", "2026-11-02T02:00:00+00:00")),
    ("2026-03-07T12:00:00+00:00", "W1", ("2026-03-01T22:00:00+00:00", "2026-03-08T21:00:00+00:00")),
    ("2026-03-31T22:00:00+00:00", "MN", ("2026-03-31T21:00:00+00:00", "2026-04-30T21:00:00+00:00")),
])
def test_ny17_dst_week_and_month_coordinates(at, frame, expected):
    assert period(stamp(at), frame, "ny17") == tuple(stamp(value) for value in expected)
    assert period(stamp(at), frame, "utc0") != tuple(stamp(value) for value in expected)


def test_fixed_reader_uses_history_before_T_target_after_T_and_previous_input_prices(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
        seam = revision.seam
        def tail(stamp, close):
            return batch(identity=identity, window_start=seam - 60000, window_end=seam + 60000,
                checkpoint=seam + 60000, observed_at=stamp, volume_kind="price_count", volume_unit="quotes",
                rows=(minute(seam - 60000, volume="9"), minute(seam, close=close, volume="3")))
        apply_minutes(db, record(db, tail(200000000, "1.11")))
        apply_minutes(db, record(db, tail(200001000, "1.12")))
        fixed = read_window(db, revision.composite_id, "M1", seam, seam + 60000, input_revision=1, now=200010000)
        latest = read_window(db, revision.composite_id, "M1", seam, seam + 60000, now=200010000)
        assert fixed["bars"][0]["close"] == "1.11" and latest["bars"][0]["close"] == "1.12"
        assert fixed["bars"][0]["segments"][0]["input"]["input_revision"] == 1
        assert fixed["bars"][0]["seam_at_start"] and not fixed["bars"][0]["seam_crossing"]
        assert fixed["history_version_id"] == revision.history_version_id
        with pytest.raises(ValueError, match="Fixed confirmed"):
            read_window(db, revision.composite_id, "M1", seam, seam + 60000, input_revision=1, provisional=True)
        with pytest.raises(ValueError, match="permission"):
            read_window(db, revision.composite_id, "M1", seam, seam + 60000, permission_scope="other")
        # Target minutes before T were intentionally excluded from this input.
        missing = read_window(db, revision.composite_id, "M1", seam - 60000, seam, now=200010000)
        assert missing["bars"] == []


def test_accepted_stream_tail_remains_provisional_after_owner_expires(database, monkeypatch):
    from alerts import live_pricing as live
    from alerts.market_contracts import QuoteEvent
    from alerts.storage import PricingOwner

    revision_id = ready(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
        composite_id = revision.composite_id
    ownership = live.claim(live.settings.oanda_account_id, now=200010000)
    epoch = live.begin_connection(ownership, {"EUR_USD": identity}, now=200010000)
    live.publish_event(ownership, epoch, QuoteEvent(identity=identity, bid="1.10", ask="1.11",
        source_time=200005000, received_at=200006000, tradeable=True, connection_epoch=epoch, sequence=1),
        {"EUR_USD": identity}, now=200010000)
    start = 200005000 // 60000 * 60000
    with database.begin() as db:
        confirmed = read_window(db, composite_id, "M1", start, start + 60000, now=200010000)
        assert confirmed["bars"] == []
        sampled = read_window(db, composite_id, "M1", start, start + 60000, provisional=True, now=200010000)
        assert len(sampled["bars"]) == 1
        bar = sampled["bars"][0]
        assert not bar["source_confirmed"] and not bar["complete"] and bar["volume"] is None
        assert bar["segments"][0]["provisional_minutes"][0]["epoch"] == epoch
        db.get(PricingOwner, ownership[0]).expires = 0
    with database.begin() as db:
        retained = read_window(db, composite_id, "M1", start, start + 60000, provisional=True, now=200010000)
        assert retained['bars'] == sampled['bars']
        assert not retained['bars'][0]['source_confirmed']
