"""Bounded D1 inputs. No subscriptions, maintenance plans, or cross-source prices."""

import time

from sqlalchemy import select

from .chart_series import decode
from .storage import (
    Bar,
    CompositeRevision,
    Instrument,
    MarketCatalog,
    MarketDataset,
    ProviderBar,
    ProviderDataset,
    RealtimeMapping,
    now_ms,
    transaction,
)


def read(ticker, cutoff, *, deadline, refresh=False):
    ident, kind = decode(ticker)
    collected = now_ms()
    if kind == "provider":
        from . import provider_cache, provider_chart

        # Provider metadata/cache share source identity with chart reads.
        from .market_resources import lane

        with lane("history"):
            meta = provider_chart.metadata(ident, deadline=deadline, cached_only=not refresh)
        if "D1" not in meta.get("frames", []):
            return {
                "ticker": ticker,
                "status": "unsupported",
                "reason": "该来源不支持 D1",
                "rows": [],
            }
        key = provider_cache.identity(meta, "D1")
        if refresh:
            key = provider_cache.ensure(meta, "D1")
            from .provider_capabilities import request_seconds

            try:
                provider_cache.fetch_page(
                    key,
                    meta,
                    "D1",
                    cutoff + 1,
                    10,
                    min(deadline, time.monotonic() + request_seconds(meta["source"])),
                    kind="history",
                    latest=True,
                    revalidate=True,
                )
            except provider_cache.LatestObservationPending:
                # An existing realtime owner is already collecting this exact
                # source. Re-read its committed cache; never call that a fault.
                pass
        if (
            meta.get("source") == "yahoo"
            and refresh
            and meta.get("asset_type") in ("EQUITY", "ETF", "stock", "etf")
        ):
            from .provider_yahoo import regular_sessions

            with lane("history"):
                sessions = regular_sessions(meta, cutoff, deadline=deadline)
            meta = {**meta, "sparkline_sessions": sessions, "session_evidence_at": now_ms()}
        with transaction() as db:
            if meta.get("source") == "yahoo" and not refresh:
                catalog = db.get(MarketCatalog, ident)
                cached = catalog.metadata_json if catalog else {}
                meta = {
                    **meta,
                    "sparkline_sessions": cached.get("sparkline_sessions", {}),
                    "session_evidence_at": cached.get("sparkline_calendar_retry_at", 0)
                    - 15 * 60000,
                }
            dataset = db.get(ProviderDataset, key)
            rows = (
                [
                    {**row.payload, "observed_at": row.observed_at}
                    for row in db.scalars(
                        select(ProviderBar)
                        .where(ProviderBar.dataset_id == key, ProviderBar.start < cutoff)
                        .order_by(ProviderBar.start.desc())
                        .limit(10)
                    )
                ]
                if dataset
                else []
            )
            revision = {"dataset_id": key, "revision": dataset.revision if dataset else None}
    elif kind in ("history", "composite"):
        from .chart_query import DataQuery
        from .series_access import chart_data, metadata

        with transaction() as db:
            meta = metadata(db, ident, kind)
            if "D1" not in meta.get("frames", []):
                return {
                    "ticker": ticker,
                    "status": "unsupported",
                    "reason": "D1 产物尚未维护",
                    "rows": [],
                }
            # No client, no indicators and confirmed-only: never renew demand.
            page = chart_data(
                db,
                DataQuery(
                    instrument=ident,
                    series_kind=kind,
                    timeframe="D1",
                    before=cutoff + 1,
                    limit=10,
                    provisional=False,
                ),
            )
            rows = page["bars"]
            if kind == "composite":
                revision_id = page.get("composite_revision_id") or page.get("revision_id")
                revision_row = db.get(CompositeRevision, revision_id) if revision_id else None
                mapping = db.get(
                    RealtimeMapping, revision_row.mapping_id if revision_row else meta["mapping_id"]
                )
                target_dataset = db.get(MarketDataset, mapping.target_dataset_id)
                target_inst = db.get(Instrument, target_dataset.instrument_id)
                meta = {
                    **meta,
                    "freshness_meta": {
                        "source": target_dataset.identity["source"],
                        "symbol": target_dataset.identity["provider_symbol"],
                        "source_identity": target_dataset.identity,
                        "calendar": meta["calendar"],
                        "calendar_profile": target_inst.calendar_profile,
                    },
                }
            revision = {
                key: page.get(key)
                for key in (
                    "history_version_id",
                    "history_checksum",
                    "composite_revision_id",
                    "input_revision",
                )
            }
    else:
        with transaction() as db:
            inst = db.get(Instrument, ident)
            if not inst:
                raise ValueError("行情已不可用")
            dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == ident))
            meta = {
                "symbol": inst.symbol,
                "display_symbol": dataset.logical_symbol if dataset else inst.id,
                "name": inst.label,
                "source": inst.source,
                "basis": inst.basis,
                "calendar": inst.calendar,
                "calendar_profile": inst.calendar_profile,
                "asset_class": dataset.asset_class if dataset else "unspecified",
                **({"source_identity": dataset.identity} if dataset else {}),
            }
            rows = [
                {
                    key: str(getattr(row, key))
                    if key in ("open", "high", "low", "close")
                    else getattr(row, key)
                    for key in ("start", "end", "open", "high", "low", "close", "complete")
                }
                for row in db.scalars(
                    select(Bar)
                    .where(
                        Bar.instrument_id == ident,
                        Bar.timeframe == "D1",
                        Bar.complete.is_(True),
                        Bar.end <= cutoff,
                    )
                    .order_by(Bar.start.desc())
                    .limit(10)
                )
            ]
            revision = {}
    if meta.get("source") == "yahoo" and meta.get("sparkline_sessions"):
        from datetime import datetime
        from zoneinfo import ZoneInfo

        for row in rows:
            date = (
                datetime.fromtimestamp(row["start"] / 1000, ZoneInfo(meta["timezone"]))
                .date()
                .isoformat()
            )
            session = meta["sparkline_sessions"].get(date)
            if session and session["end"] <= cutoff and row.get("observed_at", 0) >= session["end"]:
                row.update(
                    end=session["end"],
                    complete=True,
                    source_date=date,
                    completion_basis="dated_source_regular_session_closed",
                )
    rows = sorted(
        (
            row
            for row in rows
            if (
                row.get("complete") is True
                or (
                    kind in ("history", "composite")
                    and row.get("time_closed") is True
                    and row.get("source_confirmed") is True
                    and not row.get("session_conflict")
                )
            )
            and isinstance(row.get("start"), int)
            and isinstance(row.get("end"), int)
            and row["start"] < row["end"] <= cutoff
        ),
        key=lambda row: row["start"],
    )[-2:]
    # Keep the source's real trading-date labels, never treat them as end times.
    from datetime import UTC, datetime

    for row in rows:
        row["trading_date"] = (
            row.get("source_date")
            or datetime.fromtimestamp(row.get("chart_time", row["start"]) / 1000, UTC)
            .date()
            .isoformat()
        )
    from .briefing_freshness import assess

    status, reason, freshness = assess(meta.get("freshness_meta", meta), rows, cutoff, kind)
    from .mobile_identity import mobile_identity

    shown_identity = meta.get("mobile_identity") or mobile_identity(meta)
    return {
        "ticker": ticker,
        "symbol": meta.get("display_symbol") or meta["symbol"],
        "name": meta.get("name", meta.get("label", "")),
        "source": meta.get("source_display") or shown_identity["provider"],
        "basis": meta.get("basis", ""),
        "category": shown_identity["category"],
        "price_description": meta.get("price_basis_display")
        or meta.get("price_description", meta.get("adjustment_view", "原始价格")),
        "series_kind": kind,
        "rows": rows,
        "revision": revision,
        "collected_at": collected,
        "freshness": freshness,
        "status": status,
        "reason": reason,
    }
