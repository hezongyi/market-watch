"""Read stored composite prices without creating definitions or live demand."""

from decimal import Decimal, InvalidOperation

from .composite_chart import chart_page
from .config import settings
from .history_catalog import account_scope
from .live_pricing import account_key
from .storage import (
    CompositePreparation,
    CompositeRevision,
    LiveState,
    MarketComposite,
    MarketDataset,
    PricingOwner,
    RealtimeMapping,
    now_ms,
)


def get_snapshot(db, composite_id):
    composite = db.get(MarketComposite, composite_id)
    if not composite or composite.permission_scope != "workspace:default":
        raise ValueError("组合尚未建立或不属于当前权限范围")
    return snapshot(db, composite)


def live_snapshot(db, revision, *, now=None):
    """Quote and candle readiness are independent, both fenced by the live owner."""
    stamp = now_ms() if now is None else now
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    state = db.get(LiveState, target.id)
    owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
    current = target.identity["account_scope"] == account_scope()
    quote = state.quote if state else {}
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
    quote_ready = bool(owned and valid and quote.get("tradeable") is True
        and quote.get("connection_epoch") == state.epoch
        and age is not None and 0 <= age <= 15000
        and received_age is not None and 0 <= received_age <= 15000)
    return {"current_account": current, "owned": owned,
        "connection": state.connection if state else "inactive",
        "quote_ready": quote_ready, "confirmed_tail_ready": bool(owned and state.ready and not state.error),
        "quote_age_ms": age, "source_confirmed_end": state.confirmed_end if state else 0,
        "quote": dict(quote) if quote else {}, "received_at": state.received_at if state else None,
        "connection_epoch": state.epoch if state else None, "live_revision": state.revision if state else None}


def snapshot(db, composite, *, now=None, revision_id=None, input_revision=None):
    stamp = now_ms() if now is None else now
    revision = db.get(CompositeRevision, revision_id or composite.active_revision_id)
    if not revision or revision.composite_id != composite.id:
        raise ValueError("组合修订不属于所选系列")
    prep = db.get(CompositePreparation, revision.id)
    live = live_snapshot(db, revision, now=stamp)
    result = {"composite_id": composite.id, "revision_id": revision.id,
        "input_revision": prep.input_revision if input_revision is None else input_revision, "history_version_id": revision.history_version_id,
        "seam": revision.seam, "queried_at": stamp,
        "quote_ready": live["quote_ready"], "confirmed_tail_ready": live["confirmed_tail_ready"],
        "connection": live["connection"], "price": None, "observed_at": None,
        "quality": "pending", "price_type": None, "provenance": None}
    if input_revision is None and live["quote_ready"] and live["quote"]["source_time"] >= revision.seam:
        result.update(price=str(live["quote"]["bid"]), observed_at=live["quote"]["source_time"],
            quality="sampled", price_type="sampled_bid", provenance={
                "target_dataset_id": db.get(RealtimeMapping, revision.mapping_id).target_dataset_id,
                "connection_epoch": live["connection_epoch"], "live_revision": live["live_revision"],
                "received_at": live["received_at"], "quote": live["quote"]})
        return result
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
    return result
