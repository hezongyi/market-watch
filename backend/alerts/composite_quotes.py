"""Read stored composite prices without creating definitions or live demand."""

from decimal import Decimal, InvalidOperation

from .composite_chart import chart_page
from .composite_series import period
from .config import settings
from .history_catalog import account_scope
from .live_pricing import account_key
from .live_session import session_status
from .storage import (
    CompositePreparation,
    CompositeRevision,
    Instrument,
    LiveState,
    MarketComposite,
    MarketDataset,
    Preference,
    PricingOwner,
    RealtimeMapping,
    now_ms,
)

_previous_close_cache = {}


def get_snapshot(db, composite_id):
    composite = db.get(MarketComposite, composite_id)
    if not composite or composite.permission_scope != "workspace:default":
        raise ValueError("组合尚未建立或不属于当前权限范围")
    return snapshot(db, composite)


def live_snapshot(db, revision, *, now=None):
    """Quote and candle readiness are independent, both fenced by the live owner."""
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    state = db.get(LiveState, target.id)
    owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
    stamp = now_ms() if now is None else now
    current = target.identity["account_scope"] == account_scope()
    session = session_status(target.identity, db.get(Instrument, target.instrument_id).calendar_profile, stamp)
    held = bool(current and owner and owner.error == 'unauthorized' or state and state.error == 'unauthorized')
    error = state.error if state else None
    if current and owner and owner.error:
        probe = db.get(Preference, 'oanda_probe_status:' + owner.id) if held else None
        error = (probe.value.get('error') if probe else None) or owner.error
    available = not held and error != 'provider_maintenance' and session['market_session'] != 'closed'
    quote = state.quote if state else {}
    forming = state.forming if state else {}
    rest_sample = forming.get("acquisition_mode") == "rest_batch"
    age = stamp - quote["source_time"] if type(quote.get("source_time")) is int else None
    received_age = stamp - state.received_at if state else None
    heartbeat_age = stamp - max(state.received_at, state.heartbeat_at) if state else None
    owned = bool(current and owner and owner.token and owner.expires > stamp and state
        and state.epoch == owner.epoch and state.connection in ("connected", "recovering")
        and heartbeat_age is not None and 0 <= heartbeat_age <= 15000)
    valid = False
    try:
        bid, ask = Decimal(str(quote.get("bid"))), Decimal(str(quote.get("ask")))
        valid = bid.is_finite() and ask.is_finite() and 0 < bid <= ask
    except (InvalidOperation, ValueError):
        pass
    quote_ready = bool(available and owned and valid and quote.get("tradeable") is True
        and quote.get("connection_epoch") == state.epoch
        and age is not None and 0 <= age <= 15000
        and received_age is not None and 0 <= received_age <= 15000)
    candle_ready = bool(available and owned and state and state.ready and not state.error
        and rest_sample and forming.get("close")
        and received_age is not None and 0 <= received_age <= 15000)
    return {"current_account": current, "owned": owned,
        **session, 'authentication_hold': held, 'connection_error': error,
        'next_probe_at': owner.next_at or None if current and owner else None,
        "connection": state.connection if state else "inactive",
        "quote_ready": quote_ready, "candle_ready": candle_ready,
        "sample_ready": bool(quote_ready or candle_ready),
        "observation_mode": "candle_close_sample" if rest_sample else "stream_quote",
        "confirmed_tail_ready": bool(available and owned and state.ready and not state.error),
        "quote_age_ms": age, "received_age_ms": received_age,
        "source_confirmed_end": state.confirmed_end if state else 0,
        "quote": dict(quote) if quote else {}, "forming": dict(forming) if forming else {},
        "received_at": state.received_at if state else None,
        "connection_epoch": state.epoch if state else None, "live_revision": state.revision if state else None}


def sampled_observation(live):
    """Return the current observation using the active acquisition contract.

    Stream mode exposes a sampled bid quote.  REST candle mode exposes the
    forming candle close and deliberately carries no synthetic ask, spread, or
    tradeable flag.  Consumers should use this projection for intrabar logic so
    they cannot accidentally require quote semantics from candle-only data.
    """
    if (live.get("observation_mode") == "candle_close_sample" and live.get("owned")
            and 0 <= live.get("received_age_ms", 15001) <= 15000):
        forming = live.get("forming") or {}
        if forming.get("connection_epoch") != live.get("connection_epoch"):
            return None
        observation = forming.get("observation") or {}
        try:
            value = Decimal(str(forming["close"]))
        except (KeyError, InvalidOperation, ValueError):
            return None
        source_start = forming.get("start")
        observed_at = observation.get("received_at") or live.get("received_at")
        sequence = observation.get("sequence") or observed_at
        if not isinstance(source_start, int) or not isinstance(observed_at, int):
            return None
        return {
            "value": value, "sequence": observed_at, "source_sequence": sequence,
            "observed_at": observed_at, "source_start": source_start,
            "source_end": forming.get("end"), "kind": "sampled_candle_close",
            "observation_mode": "candle_close_sample", "candle": dict(forming),
            "source_identity": forming.get("source_identity"),
        }
    if live.get("observation_mode", "stream_quote") == "stream_quote" and live.get("owned"):
        quote = live.get("quote") or {}
        try:
            value = Decimal(str(quote["bid"]))
        except (KeyError, InvalidOperation, ValueError):
            return None
        source_time = quote.get("source_time")
        if (quote.get("connection_epoch") not in (None, live.get("connection_epoch")) or
                not isinstance(source_time, int)
                or not 0 <= live.get("quote_age_ms", 15001) <= 15000
                or not 0 <= live.get("received_age_ms", 15001) <= 15000
                or quote.get("tradeable") is not True):
            return None
        try:
            ask = Decimal(str(quote["ask"]))
            if not ask.is_finite() or ask < value:
                return None
        except (KeyError, InvalidOperation, ValueError):
            return None
        return {
            "value": value, "sequence": source_time, "source_sequence": source_time,
            "observed_at": live.get("received_at"),
            "source_start": source_time // 60000 * 60000,
            "source_end": source_time // 60000 * 60000 + 60000,
            "kind": "sampled_bid", "observation_mode": "stream_quote",
            "quote": dict(quote), "source_identity": quote.get("identity"),
        }
    return None


def json_safe(value):
    """Convert Decimal-rich domain evidence into JSON-compatible values."""
    def safe(value):
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, dict):
            return {key: safe(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [safe(item) for item in value]
        return value

    return safe(value)


def observation_evidence(sample):
    """Copy a sampled observation into JSON-safe audit evidence."""
    return json_safe(sample)


def previous_close(db, composite, *, revision, input_revision, observed_at):
    """Return the prior closed, source-confirmed NY17 daily close.

    Composite quotes can be sampled from a live bid, a forming REST candle, or
    a stored M1 tail.  Their observation clocks differ, but the change shown in
    the watchlist must always compare against the same composite revision's
    previous completed NY17 session.  The indexed D1 reader keeps this lookup
    bounded and applies the same frozen input revision as the quote.
    """
    if not isinstance(observed_at, int):
        return None
    calendar = revision.rules["aggregation_calendar"]
    session_start, _ = period(observed_at, "D1", calendar)
    key = (id(db.get_bind()), composite.id, revision.id, input_revision, session_start)
    if session_start < 0:
        return None
    if key in _previous_close_cache:
        return _previous_close_cache[key]
    page = chart_page(
        db,
        composite.id,
        "D1",
        before=session_start,
        count=1,
        revision_id=revision.id,
        input_revision=input_revision,
        provisional=False,
        now=observed_at,
    )
    bars = [
        row for row in page.get("bars", [])
        if row.get("end", 0) <= session_start
        and row.get("source_confirmed") is True
        and row.get("time_closed") is True
    ]
    if not bars:
        # An artifact can publish later without changing the pinned minute
        # input revision. Never retain a missing/unverified baseline.
        return None
    value = bars[-1].get("close")
    try:
        value = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        value = None
    else:
        value = value if value.is_finite() and value > 0 else None
    if value is None:
        return None
    _previous_close_cache[key] = value
    if len(_previous_close_cache) > 2048:
        _previous_close_cache.pop(next(iter(_previous_close_cache)))
    return value


def snapshot(db, composite, *, now=None, revision_id=None, input_revision=None):
    stamp = now_ms() if now is None else now
    revision = db.get(CompositeRevision, revision_id or composite.active_revision_id)
    if not revision or revision.composite_id != composite.id:
        raise ValueError("组合修订不属于所选系列")
    prep = db.get(CompositePreparation, revision.id)
    live = live_snapshot(db, revision, now=stamp)
    from .market_calendar import session_status as presentation_session

    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    profile = db.get(Instrument, target.instrument_id).calendar_profile
    session = presentation_session(target.identity["source"], target.identity["provider_symbol"], stamp,
        metadata={"source_identity": target.identity, "calendar_profile": profile,
                  "calendar_verified": bool(profile)})
    if not live["current_account"]:
        session = {"market_session": "unknown", "session_reason": "接续来源账户已变化",
                   "calendar_verified": False, "calendar_version": None}
    result = {"composite_id": composite.id, "revision_id": revision.id,
        "input_revision": prep.input_revision if input_revision is None else input_revision, "history_version_id": revision.history_version_id,
        "seam": revision.seam, "queried_at": stamp,
        "quote_ready": live["quote_ready"], "candle_ready": live.get("candle_ready", False),
        "sample_ready": live.get("sample_ready", live["quote_ready"]),
        "observation_mode": live.get("observation_mode", "stream_quote"),
        "confirmed_tail_ready": live["confirmed_tail_ready"],
        "connection": live["connection"], "price": None, "observed_at": None,
        "previous_close": None,
        "quality": "pending", "price_type": None, "provenance": None,
        **session, "read_at": stamp, "source_identity": target.identity,
        "fetch_status": live["connection_error"] or "ok"}
    def presented():
        # Compare only observations from the selected continuation source;
        # historical-side bars carry their own immutable source identity.
        provenance = result.get("provenance") or {}
        sampled = result["price_type"] in ("sampled_bid", "sampled_candle_close")
        if sampled or any(part.get("segment") == "target" for part in provenance.get("segments", ())):
            from .market_data import _session_observation

            result.update(_session_observation(target.identity["source"], target.identity["provider_symbol"],
                session, result["observed_at"] if sampled else provenance.get("start"),
                {"source_identity": target.identity, "calendar_profile": profile,
                 "calendar_verified": bool(profile)}, event_end=None if sampled else provenance.get("end")))
        return result
    if input_revision is None and live["quote_ready"] and live["quote"]["source_time"] >= revision.seam:
        result.update(price=str(live["quote"]["bid"]), observed_at=live["quote"]["source_time"],
            quality="sampled", price_type="sampled_bid", provenance={
                "target_dataset_id": db.get(RealtimeMapping, revision.mapping_id).target_dataset_id,
                "connection_epoch": live["connection_epoch"], "live_revision": live["live_revision"],
                "received_at": live["received_at"], "quote": live["quote"]})
        value = previous_close(db, composite, revision=revision,
            input_revision=result["input_revision"], observed_at=result["observed_at"])
        result["previous_close"] = str(value) if value is not None else None
        return presented()
    if input_revision is None and live.get("candle_ready"):
        forming = live.get("forming") or {}
        if forming.get("start", -1) >= revision.seam:
            result.update(price=str(forming["close"]), observed_at=live["received_at"],
                quality="sampled", price_type="sampled_candle_close", provenance={
                    "target_dataset_id": db.get(RealtimeMapping, revision.mapping_id).target_dataset_id,
                    "connection_epoch": live["connection_epoch"], "live_revision": live["live_revision"],
                    "received_at": live["received_at"], "candle": forming,
                    "observation_mode": "candle_close_sample"})
            value = previous_close(db, composite, revision=revision,
                input_revision=result["input_revision"], observed_at=forming.get("start"))
            result["previous_close"] = str(value) if value is not None else None
            return presented()
    # Uses the same pinned M1 input as the chart; never raw target history that
    # has not been accepted by this composite revision. Historical side is <T.
    page = chart_page(db, composite.id, "M1", before=stamp//60000*60000, count=1, provisional=False, now=stamp,
                      revision_id=revision.id, input_revision=input_revision)
    bars = [bar for bar in page["bars"] if bar["source_confirmed"] and bar["end"] <= stamp]
    if bars:
        bar = bars[-1]
        result.update(price=bar["close"], observed_at=bar["end"], price_type="confirmed_m1_close",
            quality="stored", provenance={"segments": bar["segments"],
                "coverage_complete": bar["coverage_complete"], "time_closed": bar["time_closed"],
                "source_confirmed": bar["source_confirmed"], "start": bar["start"], "end": bar["end"]})
    if not live["current_account"]:
        result["quality"] = "account_changed"
    value = previous_close(db, composite, revision=revision,
        input_revision=result["input_revision"], observed_at=result["observed_at"])
    result["previous_close"] = str(value) if value is not None else None
    return presented()
