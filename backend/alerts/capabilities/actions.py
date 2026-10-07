"""Registered business actions, reusing the browser's query and rule Interfaces."""

import asyncio

from sqlalchemy import func, select

from .. import business
from ..chart_api import DataQuery, query_chart
from ..chart_indicators import public_catalog
from ..config import settings
from ..storage import Bar, ChartPublishedBar, Instrument, SignalRow, Watch, now_ms, transaction
from .context import CapabilityError
from .models import (
    AckNotification,
    AlertQuery,
    AlertsResult,
    BarsQuery,
    BarsResult,
    CancelAlert,
    CatalogResult,
    CreateAlert,
    DrawingsQuery,
    DrawingsResult,
    Empty,
    IndicatorsQuery,
    InstrumentQuery,
    InstrumentsResult,
    NotificationResult,
    QuoteQuery,
    QuoteResult,
    SignalsQuery,
    SignalsResult,
    StatusResult,
    WatchResult,
    WorkspacesQuery,
    WorkspacesResult,
)
from .registry import Capability, Registry


def paginate(rows, query):
    page = rows[query.offset : query.offset + query.limit]
    return {
        "items": page,
        "next_offset": query.offset + query.limit
        if len(rows) > query.offset + query.limit
        else None,
    }


def list_instruments(ctx, query):
    if query.series_kind == "managed":
        rows = [
            {**row, "series_kinds": ["managed"]}
            for row in business.instruments()
            if query.query.casefold() in (row["id"] + row["label"]).casefold()
        ]
    else:
        from ..market_data import instrument_catalog

        rows = [
            row
            for row in instrument_catalog(query.query)
            if "provider" in row.get("series_kinds", [])
        ]
    return {**paginate(rows, query), "queried_at": now_ms()}


def identity(query, deadline=None):
    if query.series_kind == "provider":
        from ..provider_chart import metadata

        return metadata(query.instrument, deadline=deadline)
    with transaction() as db:
        inst = db.get(Instrument, query.instrument)
        if not inst:
            raise CapabilityError("DATA_UNAVAILABLE", "Unknown instrument")
        return {
            key: getattr(inst, key)
            for key in ("source", "basis", "calendar", "precision", "calendar_profile")
        }


async def bars(ctx, query):
    async def disconnected():
        return ctx.cancelled.is_set()

    specs = (
        [item.model_dump() for item in query.indicators]
        if isinstance(query, IndicatorsQuery)
        else []
    )
    if specs and query.series_kind == "managed":

        def history_size():
            frame = (
                "M15"
                if query.timeframe == "M30"
                else "D1"
                if query.timeframe in ("W1", "MN")
                else query.timeframe
            )
            model = ChartPublishedBar if query.published else Bar
            if query.published:
                frame = query.timeframe
            with transaction() as db:
                return db.scalar(
                    select(func.count())
                    .select_from(model)
                    .where(model.instrument_id == query.instrument, model.timeframe == frame)
                )

        if await asyncio.to_thread(history_size) > 200000:
            raise CapabilityError("RESOURCE_LIMIT", "Managed indicator history exceeds 200000 bars")
    meta = await asyncio.to_thread(identity, query, ctx.deadline)
    page = await query_chart(
        DataQuery(**query.model_dump(exclude={"indicators"}), indicators=specs, track_history=True),
        disconnected=disconnected,
        deadline=ctx.deadline,
        retain_work=True,
    )
    if not page["bars"]:
        raise CapabilityError(
            "DATA_UNAVAILABLE",
            "No candles available",
            True,
            {"instrument": query.instrument, "series_kind": query.series_kind},
        )
    unavailable = [
        item["name"]
        for item in page["indicators"]
        if all(v["value"] is None for s in item["series"] for v in s["values"])
    ]
    if unavailable:
        raise CapabilityError(
            "INSUFFICIENT_HISTORY",
            "No valid values for requested indicators",
            False,
            {"indicators": unavailable, "origin": page.get("origin")},
        )
    from ..calendar_profile import closures_from
    from ..chart_history_plan import bucket_has_trading
    from ..domain import Calendar
    from ..storage import instant

    interval_breaks = [
        {"start": prev["end"], "end": row["start"]}
        for prev, row in zip(page["bars"], page["bars"][1:])
        if prev["end"] < row["start"]
    ]
    # Yahoo exchange calendars cannot be classified by the NY17/UTC0 rules.
    # A session close is an interval break, not proof of missing trading bars.
    known_calendar = meta["calendar"] in {calendar.value for calendar in Calendar}
    gaps = (
        [
            gap
            for gap in interval_breaks
            if bucket_has_trading(
                instant(gap["start"]),
                instant(gap["end"]),
                Calendar(meta["calendar"]),
                gold=query.instrument == "XAUUSD",
                closures=closures_from(meta.get("calendar_profile", {})),
            )
        ]
        if known_calendar
        else []
    )
    incomplete_count = sum(not row["complete"] for row in page["bars"])
    quality = (
        "gapped"
        if gaps
        else "incomplete"
        if incomplete_count
        else "calendar_unverified"
        if not known_calendar
        else "complete"
    )
    return {
        "instrument": query.instrument,
        "series_kind": query.series_kind,
        "source": meta["source"],
        "timeframe": query.timeframe,
        "price_type": meta["basis"] + " OHLC",
        "queried_at": now_ms(),
        "quality": quality,
        "next_before": (
            page["bars"][0].get("chart_time", page["bars"][0]["start"])
            if query.series_kind == "provider"
            else page["bars"][0]["start"]
        )
        if page["has_more"]
        else None,
        "cursor_coordinate": "native_chart_time_ms"
        if query.series_kind == "provider"
        else "utc_ms",
        "page": page,
        "incomplete_count": incomplete_count,
        "gaps": gaps,
        "interval_breaks": interval_breaks,
        "gap_assessment": "trading_calendar" if known_calendar else "unknown_calendar",
    }


async def quote(ctx, query):
    if query.series_kind == "managed":
        rows = await asyncio.to_thread(business.instruments)
        row = next((r for r in rows if r["id"] == query.instrument), None)
        if not row or row["price"] is None:
            raise CapabilityError("DATA_UNAVAILABLE", "No price available", True)
        return {
            "instrument": row["id"],
            "series_kind": "managed",
            "source": row["source"],
            "basis": row["basis"],
            "price": row["price"],
            "price_type": row["price_type"],
            "observed_at": row["price_at"],
            "queried_at": now_ms(),
            "quality": row["quality"],
            "age_seconds": row["age_seconds"],
            "calendar": row["calendar"],
            "precision": row["precision"],
            "market_open": row["market_open"],
            "is_stale": row["is_stale"],
        }
    meta = await asyncio.to_thread(identity, query, ctx.deadline)
    if meta["source"] == "yahoo":
        from ..provider_service import yahoo_quote

        snap = await asyncio.to_thread(yahoo_quote, meta, deadline=ctx.deadline)
        if snap.get("price") is None or snap.get("quote_time") is None:
            raise CapabilityError("DATA_UNAVAILABLE", "Provider quote unavailable", True)
        return {
            "instrument": query.instrument,
            "series_kind": "provider",
            "source": "yahoo",
            "basis": meta["basis"],
            "price": str(snap["price"]),
            "price_type": "market quote",
            "observed_at": snap["quote_time"],
            "queried_at": now_ms(),
            "quality": snap["status"],
            "age_seconds": (now_ms() - snap["quote_time"]) // 1000,
            "calendar": meta["calendar"],
            "precision": meta["precision"],
            "delay_seconds": snap["delay_seconds"],
            "is_stale": snap["status"] != "ok",
        }
    result = await bars(ctx, BarsQuery(**query.model_dump(), timeframe="M1", limit=1))
    last = result["page"]["bars"][-1]
    observed = min(last["end"], result["page"]["as_of"])
    return {
        "instrument": query.instrument,
        "series_kind": "provider",
        "source": meta["source"],
        "basis": meta["basis"],
        "price": last["close"],
        "price_type": "M1 close",
        "observed_at": observed,
        "queried_at": now_ms(),
        "quality": "stale"
        if now_ms() - observed > 180000
        else "provisional"
        if not last["complete"]
        else "receiving",
        "age_seconds": (now_ms() - observed) // 1000,
        "calendar": meta["calendar"],
        "precision": meta["precision"],
        "is_stale": now_ms() - observed > 180000,
    }


def indicators(ctx, query):
    return {
        "indicators": public_catalog(),
        "policy": "Python version 1; complete candles by default; opt in with provisional=true for the last incomplete candle, whose values are marked provisional. Gaps reset state; null is unavailable. "
        "Managed full persisted prefix; provider warmup as returned by shared chart query.",
    }


def alerts(ctx, query):
    rows = business.watches(query.limit + 1, query.offset, query.instrument, query.status)
    return {
        "items": rows[: query.limit],
        "next_offset": query.offset + query.limit if len(rows) > query.limit else None,
    }


def signals(ctx, query):
    # The shared browser view is capped at the newest 500 signals.
    rows = [
        r
        for r in business.signals()
        if (not query.instrument or r["instrument_id"] == query.instrument)
        and (not query.watch_id or r["watch_id"] == query.watch_id)
    ]
    return paginate(rows, query)


def system(ctx, query):
    with transaction() as db:
        active = db.scalar(select(func.count()).select_from(Watch).where(Watch.status == "active"))
        recent = db.scalar(
            select(func.count())
            .select_from(SignalRow)
            .where(SignalRow.created_at > now_ms() - 86400000)
        )
    return {
        "mcp_enabled": settings.mcp_enabled,
        "queried_at": now_ms(),
        "active_alerts": active,
        "recent_signals": recent,
        "delivery_enabled": settings.delivery_enabled,
        "tools": [cap.name for cap in build_registry().visible(ctx.scopes)],
    }


def create(ctx, query, db):
    return business.new_watch_in(db, query.watch)


def cancel(ctx, query, db):
    return business.cancel_watch_in(db, query.watch_id)


def ack(ctx, query, db):
    return business.ack_in(db, query.notification_id)


def build_registry():
    from .drawings import drawings, workspaces
    from .history import register_history

    registry = Registry()
    definitions = [
        (
            "market_list_instruments",
            "Discover instrument IDs and available series. Paginated, at most 500.",
            InstrumentQuery,
            InstrumentsResult,
            "market:read",
            list_instruments,
        ),
        (
            "market_get_quote",
            "Price with source, observation time, basis and freshness. Provider M1-close fallback is labelled.",
            QuoteQuery,
            QuoteResult,
            "market:read",
            quote,
        ),
        (
            "market_get_bars",
            "OHLC strings and chart quality/revision/coverage metadata. UTC bar start/end; next_before follows cursor_coordinate (provider native chart labels). Default 300, max 2000. Bounded cache fill only; no persistent history subscription.",
            BarsQuery,
            BarsResult,
            "market:read",
            bars,
        ),
        (
            "indicators_list",
            "Discover backend Python indicators, versions, parameter and output schemas.",
            Empty,
            CatalogResult,
            "analysis:read",
            indicators,
        ),
        (
            "indicators_calculate",
            "Calculate 1–12 indicators from the shared chart snapshot with original warmup, gaps and revisions. Null is unavailable. Max 2000 visible bars.",
            IndicatorsQuery,
            BarsResult,
            "analysis:read",
            bars,
        ),
        (
            "alerts_list",
            "Read existing one-shot alerts, paginated and filtered.",
            AlertQuery,
            AlertsResult,
            "alerts:read",
            alerts,
        ),
        (
            "alerts_get_signals",
            "Read the newest 500 signal/notification results with pagination and filters.",
            SignalsQuery,
            SignalsResult,
            "alerts:read",
            signals,
        ),
        (
            "system_get_status",
            "Sanitized status and capability names visible to this credential.",
            Empty,
            StatusResult,
            "market:read",
            system,
        ),
        (
            "charts_list_workspaces",
            "List saved native or legacy workspaces and projection availability. No unsaved browser state.",
            WorkspacesQuery,
            WorkspacesResult,
            "charts:read",
            workspaces,
        ),
        (
            "charts_get_drawings",
            "Read supported saved drawing coordinates and chart identities at one workspace revision. Unknown objects are unsupported; old native saves require resaving for projection.",
            DrawingsQuery,
            DrawingsResult,
            "charts:read",
            drawings,
        ),
        (
            "alerts_create",
            "Create one-shot alert with existing business validation. Required stable idempotency key; same key with different intent conflicts.",
            CreateAlert,
            WatchResult,
            "alerts:write",
            create,
        ),
        (
            "alerts_cancel",
            "Cancel an existing alert using an idempotency key.",
            CancelAlert,
            WatchResult,
            "alerts:write",
            cancel,
        ),
        (
            "notifications_ack",
            "Acknowledge an existing notification using an idempotency key.",
            AckNotification,
            NotificationResult,
            "alerts:write",
            ack,
        ),
    ]
    for name, description, inp, out, scope, handler in definitions:
        scopes = {scope}
        if name == "indicators_calculate":
            scopes.add("market:read")
        registry.register(
            Capability(
                name,
                description,
                inp,
                out,
                frozenset(scopes),
                "write" if scope.endswith(":write") else "read",
                handler,
            )
        )
    register_history(registry)
    from .history_writes import register_history_writes

    register_history_writes(registry)
    from .composite import register_composite

    register_composite(registry)
    return registry.freeze()
