from datetime import datetime

from alerts.market_calendar import calendar_rows, session_status


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def test_dukascopy_gold_weekend_is_closed_without_using_24x7_metadata():
    state = session_status("dukascopy", "XAU/USD", stamp("2026-10-10T11:45:00+00:00"))
    assert state == {
        "market_session": "closed",
        "session_reason": "周末",
        "calendar_verified": True,
        "calendar_version": "dukascopy-spot-v1",
    }


def test_dukascopy_managed_catalog_spelling_uses_the_same_calendar_rule():
    state = session_status("dukascopy", "xauusd", stamp("2026-10-10T11:45:00+00:00"))
    assert state["market_session"] == "closed"
    assert state["calendar_version"] == "dukascopy-spot-v1"


def test_gold_daily_break_and_dst_follow_new_york_timezone():
    pause = session_status("dukascopy", "XAU/USD", stamp("2026-10-05T21:30:00+00:00"))
    open_after = session_status("dukascopy", "XAU/USD", stamp("2026-10-05T22:30:00+00:00"))
    assert pause["market_session"] == "closed" and pause["session_reason"] == "每日暂停"
    assert open_after["market_session"] == "scheduled_open"


def test_dukascopy_friday_close_and_sunday_reopen_follow_new_york_boundary():
    friday = session_status("dukascopy", "EURUSD", stamp("2026-10-09T21:00:00+00:00"))
    sunday = session_status("dukascopy", "EUR/USD", stamp("2026-10-11T21:00:00+00:00"))
    assert friday["market_session"] == "closed"
    assert sunday["market_session"] == "scheduled_open"


def test_expired_calendar_and_unreviewed_sources_remain_unknown():
    expired = session_status("dukascopy", "XAU/USD", stamp("2027-04-01T12:00:00+00:00"))
    pending = session_status("oanda", "EUR_USD", stamp("2026-10-12T12:00:00+00:00"))
    assert expired["market_session"] == "unknown"
    assert pending["market_session"] == "unknown"


def test_review_due_is_a_reminder_not_an_applicability_boundary():
    due = session_status("dukascopy", "EUR/USD", stamp("2026-11-11T12:00:00+00:00"))
    assert due["market_session"] == "scheduled_open"
    assert session_status("dukascopy", "XAUUSD", stamp("2026-11-14T12:00:00+00:00"))["market_session"] == "closed"
    row = next(item for item in calendar_rows(source="dukascopy", as_of=datetime.fromisoformat(
        "2026-11-11T12:00:00+00:00")) if item["source"] == "dukascopy")
    assert row["status"] == "review_due"


def test_unmapped_source_stays_unknown_and_calendar_page_lists_all_sources():
    assert session_status("yahoo", "AAPL", stamp("2026-10-12T12:00:00+00:00"))["market_session"] == "unknown"
    rows = calendar_rows()
    assert {row["source"] for row in rows} == {"dukascopy", "oanda", "binance", "yahoo"}


def test_oanda_account_profile_is_identity_bound_and_keeps_boundary_unknown(monkeypatch):
    import hashlib

    from alerts.config import settings

    scope = "sha256:" + hashlib.sha256(b"calendar-fixture").hexdigest()
    profile = {
        "revision": "oanda-fixture-v1",
        "source_session": {
            "source": "oanda", "channel": "v20", "environment": "practice",
            "provider_symbol": "EUR_USD", "account_scope": scope,
            "timezone": "America/New_York",
            "reviewed_start": "2026-01-01T00:00:00+00:00",
            "reviewed_end": "2027-01-01T00:00:00+00:00",
            "evidence_url": "https://example.test/oanda-calendar",
            "applicability": "Synthetic account-bound fixture",
            "weekly_closures": [{"start": 0, "end": 120}, {"start": 4 * 1440 + 17 * 60, "end": 7 * 1440}],
        },
        "closures": [],
    }
    monkeypatch.setattr(settings, "oanda_calendar_profiles", {"EUR_USD": profile})
    monkeypatch.setattr(settings, "oanda_calendar_verified", True)
    identity = {key: profile["source_session"][key] for key in (
        "source", "channel", "environment", "provider_symbol", "account_scope")}
    closed = session_status("oanda", "EUR_USD", stamp("2026-10-10T22:00:00+00:00"), metadata={
        "calendar_profile": profile, "calendar_verified": True, "source_identity": identity,
    })
    assert closed["market_session"] == "closed"
    assert session_status("oanda", "EUR_USD", stamp("2026-10-12T06:00:00+00:00"), metadata={
        "calendar_profile": profile, "calendar_verified": True, "source_identity": identity,
    })["market_session"] == "unknown"
    assert session_status("oanda", "EUR_USD", stamp("2026-10-10T22:00:00+00:00"), metadata={
        "calendar_profile": profile, "calendar_verified": False,
    })["market_session"] == "unknown"
    assert session_status("oanda", "XAU_USD", stamp("2026-10-10T22:00:00+00:00"), metadata={
        "calendar_profile": profile, "calendar_verified": True,
    })["market_session"] == "unknown"


def test_binance_without_verified_evidence_remains_unknown():
    assert session_status("binance", "BTCUSDT", stamp("2026-10-12T12:00:00+00:00"))["market_session"] == "unknown"
    assert session_status("binance", "ETHUSDT", stamp("2026-10-12T12:00:00+00:00"))["market_session"] == "unknown"


def test_calendar_rows_expose_mapping_and_exception_fields():
    row = next(item for item in calendar_rows(source="oanda") if item["source"] == "oanda")
    assert row["mappings"] == ["EUR_USD", "XAU_USD"]
    assert row["exceptions"] and row["exceptions"][0]["source"].startswith("https://")


def test_session_observation_marks_closed_events_not_normal_old_quotes():
    from alerts.market_data import _session_observation

    closed = {"market_session": "closed"}
    metadata = {}
    assert _session_observation(
        "dukascopy", "XAU/USD", closed, stamp("2026-10-10T11:45:00+00:00"), metadata
    )["session_conflict"]
    assert _session_observation(
        "dukascopy", "XAU/USD", closed, stamp("2026-10-09T20:00:00+00:00"), metadata
    ) == {}
    assert _session_observation(
        "dukascopy", "XAU/USD", {"market_session": "scheduled_open"},
        stamp("2026-10-10T11:45:00+00:00"), metadata,
    )["session_conflict"]


def test_profile_must_match_the_actual_account_channel_and_environment():
    identity = {"source": "oanda", "channel": "v20", "environment": "practice",
                "provider_symbol": "EUR_USD", "account_scope": "sha256:" + "a" * 64}
    profile = {"revision": "foreign-v1", "source_session": {
        **identity, "environment": "live", "account_scope": "sha256:" + "b" * 64,
        "timezone": "America/New_York", "reviewed_start": "2026-01-01T00:00:00Z",
        "reviewed_end": "2027-01-01T00:00:00Z", "evidence_url": "https://example.test/rule",
        "applicability": "Synthetic account mismatch", "weekly_closures": [{"start": 6780, "end": 10080}],
    }}
    state = session_status("oanda", "EUR_USD", stamp("2026-10-10T12:00:00+00:00"), metadata={
        "source_identity": identity, "calendar_profile": profile, "calendar_verified": True,
    })
    assert state["market_session"] == "unknown" and not state["calendar_verified"]


def test_calendar_search_accepts_managed_display_code():
    assert calendar_rows(source="dukascopy", query="XAUUSD") == calendar_rows(source="dukascopy", query="XAU/USD")


def test_runtime_calendar_reads_enabled_sources_and_same_account_profile_without_writes(database, monkeypatch):
    from alerts.config import settings
    from alerts.history_catalog import account_scope
    from alerts.storage import MarketDemand
    from sqlalchemy import select

    monkeypatch.setattr(settings, "oanda_account_id", "fixture-account")
    monkeypatch.setattr(settings, "oanda_token", "fixture-token")
    monkeypatch.setattr(settings, "yahoo_enabled", False)
    identity = {"source": "oanda", "channel": "v20", "environment": "practice",
                "provider_symbol": "EUR_USD", "account_scope": account_scope()}
    profile = {"revision": "fixture-live-v1", "source_session": {
        **identity, "timezone": "America/New_York", "reviewed_start": "2026-01-01T00:00:00Z",
        "reviewed_end": "2027-01-01T00:00:00Z", "evidence_url": "https://example.test/rule",
        "applicability": "Synthetic reviewed account", "weekly_closures": [{"start": 6780, "end": 10080}],
    }}
    monkeypatch.setattr(settings, "oanda_live_session_profiles", {"EUR_USD": profile})
    moment = datetime.fromisoformat("2026-10-10T12:00:00+00:00")
    with database() as db:
        rows = calendar_rows(as_of=moment, db=db)
        actual = next(row for row in rows if row["source"] == "oanda" and row["version"] == "fixture-live-v1")
        assert actual["market_session"] == "closed" and actual["status"] == "verified"
        assert actual["enabled"] and actual["evidence"] == ["https://example.test/rule"]
        assert all(row["enabled"] is False for row in rows if row["source"] == "yahoo")
        assert db.scalar(select(MarketDemand)) is None


def test_conflict_detection_preserves_boundary_minute_and_winter_dst():
    from alerts.market_data import _session_observation

    boundary = stamp("2026-11-09T22:00:00+00:00")
    assert _session_observation("dukascopy", "XAUUSD", {}, boundary, {}, event_end=boundary + 60000) == {}
    interior = boundary + 60000
    assert _session_observation("dukascopy", "XAUUSD", {}, interior, {}, event_end=interior + 60000)["session_conflict"]
    assert session_status("dukascopy", "XAUUSD", boundary + 3600000)["market_session"] == "scheduled_open"


def test_profile_closure_proves_holiday_closed_and_preserves_unknown_open_side():
    profile = {
        "revision": "holiday-fixture-v1",
        "closures": [{
            "start": "2026-10-12T12:00:00+00:00",
            "end": "2026-10-12T13:00:00+00:00",
            "reason": "节假日",
            "source": "https://example.test/holiday",
        }],
    }
    closed = session_status("yahoo", "AAPL", stamp("2026-10-12T12:30:00+00:00"), metadata={
        "calendar_profile": profile,
        "calendar_verified": True,
    })
    assert closed == {
        "market_session": "closed",
        "session_reason": "节假日",
        "calendar_verified": True,
        "calendar_version": "holiday-fixture-v1",
    }
    assert session_status("yahoo", "AAPL", stamp("2026-10-12T13:30:00+00:00"), metadata={
        "calendar_profile": profile,
        "calendar_verified": True,
    })["market_session"] == "unknown"


def test_runtime_calendar_preserves_same_symbol_dataset_scopes_and_malformed_rules(database):
    from alerts.storage import Instrument

    with database.begin() as db:
        for ident in ("scope-a", "scope-b"):
            db.add(Instrument(id=ident, label=ident, source="yahoo", symbol="AAPL",
                basis="last", calendar="utc0", precision=2,
                calendar_profile={"revision": ident, "closures": [{"start": "invalid"}]}))
    with database() as db:
        rows = calendar_rows(db=db, source="yahoo", query="AAPL")
        assert {row["version"] for row in rows} == {"scope-a", "scope-b"}
        assert all(row["status"] == "unverified" for row in rows)
        assert all(row["checked_at"] is None for row in rows)


def test_calendar_includes_used_native_cache_symbols_once_without_demand(database):
    from alerts.storage import MarketDemand, ProviderDataset
    from sqlalchemy import select

    with database.begin() as db:
        for frame in ("M1", "H1"):
            db.add(ProviderDataset(id="used-native-" + frame, source="binance", symbol="ETHUSDT",
                timeframe=frame, metadata_json={"source": "binance", "symbol": "ETHUSDT"}))
    with database() as db:
        rows = calendar_rows(db=db, source="binance", query="ETHUSDT")
        assert len(rows) == 1 and rows[0]["market_session"] == "unknown"
        assert rows[0]["mappings"] == ["ETHUSDT"]
        assert db.scalar(select(MarketDemand)) is None


def test_builtin_rule_never_certifies_a_different_observation_identity():
    for source, symbol, channel in (("oanda", "XAU/USD", "json3"),
                                   ("dukascopy", "EUR/USD", "json3"),
                                   ("dukascopy", "XAU/USD", "unreviewed-channel")):
        state = session_status("dukascopy", "XAU/USD", stamp("2026-10-10T12:00:00+00:00"),
            metadata={"source_identity": {"source": source, "provider_symbol": symbol,
                "channel": channel, "environment": "historical", "account_scope": "public"}})
        assert state["market_session"] == "unknown" and not state["calendar_verified"]


def test_calendar_keeps_mapped_symbols_with_distinct_actual_channels(database):
    from alerts.storage import Instrument, MarketDataset, ProviderDataset

    moment = datetime.fromisoformat("2026-10-10T12:00:00+00:00")
    identity = {"source": "dukascopy", "channel": "python", "environment": "historical",
                "provider_symbol": "XAU/USD", "account_scope": "public"}
    with database.begin() as db:
        db.add(Instrument(id="python-gold", label="Python gold", source="dukascopy",
            symbol="XAU/USD", basis="bid", calendar="ny17", precision=3))
        db.add(MarketDataset(id="python-gold-data", instrument_id="python-gold",
            logical_symbol="XAUUSD", identity=identity, volume_kind="unavailable"))
        for frame in ("M1", "H1"):
            db.add(ProviderDataset(id="json3-gold-" + frame, source="dukascopy",
                symbol="XAU/USD", timeframe=frame,
                metadata_json={"source": "dukascopy", "symbol": "XAU/USD"}))
    with database() as db:
        rows = calendar_rows(db=db, source="dukascopy", query="XAUUSD", as_of=moment)
    actual = next(row for row in rows if "python-gold" in row.get("row_id", ""))
    expected = session_status("dukascopy", "XAU/USD", int(moment.timestamp() * 1000),
                              metadata={"source_identity": identity})
    assert actual["market_session"] == expected["market_session"] == "unknown"
    assert actual["status"] == "unverified"
    native = [row for row in rows if "provider:" in row.get("row_id", "")]
    assert len(native) == 1 and native[0]["market_session"] == "closed"


def test_calendar_keeps_native_price_parameters_but_deduplicates_periods(database):
    from alerts.native_series import DEFAULTS
    from alerts.storage import ProviderDataset

    with database.begin() as db:
        for ident, basis, price, smooth, frame in (
            ("bid-m1", "bid", "B", False, "M1"), ("bid-h1", "bid", "B", False, "H1"),
            ("ask-m1", "ask", "A", False, "M1"), ("smooth-m1", "bid", "B", True, "M1"),
        ):
            identity = {"source": "oanda", "channel": "v20", "environment": "practice",
                "provider_symbol": "EUR_USD", "account_scope": "sha256:" + "a" * 64,
                "basis": basis, "parameters": {**DEFAULTS, "price": price, "smooth": smooth, "granularity": frame}}
            db.add(ProviderDataset(id=ident, source="oanda", symbol="EUR_USD", timeframe=frame,
                metadata_json={"source": "oanda", "symbol": "EUR_USD", "basis": basis, "native_identity": identity}))
    with database() as db:
        rows = calendar_rows(db=db, source="oanda", query="EURUSD",
            as_of=datetime.fromisoformat("2026-10-10T12:00:00+00:00"))
    native = [row for row in rows if "provider:" in row.get("row_id", "")]
    assert len(native) == 3
    assert {row["price_basis"] for row in native} == {"bid", "ask"}
    assert len([row for row in native if row["native_parameters"]["smooth"]]) == 1
    assert all(row["market_session"] == "unknown" for row in native)
