"""Bounded mobile sparkline observations and explicit provider history preparation.

Batch observations never write demand or bookkeeping. Only prepare() invokes the
shared provider cache writer, without registering an instrument or starting jobs.
"""

import logging
from datetime import UTC, datetime, timedelta
from itertools import islice
from zoneinfo import ZoneInfo

from sqlalchemy import select

from . import storage
from .chart_series import decode
from .query_errors import QueryError
from .storage import (
    CompositeRevision,
    HistoryArtifact,
    HistoryVersion,
    Instrument,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    ProviderBar,
    ProviderDataset,
)

FRAMES = {"M1": 60000, "M5": 300000, "M15": 900000, "M30": 1800000, "H1": 3600000}
MAX_POINTS = 1600  # A 25-hour NY session contains at most 1500 M1 observations.
log = logging.getLogger(__name__)


def window(stamp, asset):
    """Adjacent local dates, not an elapsed 24 hours, define the NY17 window."""
    kind = (asset or "").upper()
    ny = kind in ("FOREX", "CURRENCY", "FX", "METAL", "GOLD") or kind.startswith("INSTRUMENT_FX_")
    zone = ZoneInfo("America/New_York") if ny else UTC
    local = datetime.fromtimestamp(stamp / 1000, zone)
    left = local.replace(hour=17 if ny else 0, minute=0, second=0, microsecond=0)
    if local < left:
        left -= timedelta(days=1)
    right = left + timedelta(days=1)
    return int(left.timestamp() * 1000), int(right.timestamp() * 1000)


def stock_clock(meta, stamp):
    """Only explicit regular-hours stock metadata enables session carry-forward.

    These bounds define the chart axis, not proof that a calendar date is open.
    The displayed trading date always comes from actual source bars.
    """
    if (meta["source"] == "yahoo" and meta.get("asset_type") in {"EQUITY", "ETF", "INDEX"}
            and meta.get("timezone") and meta.get("session") == "0930-1600:23456"):
        return datetime.fromtimestamp(stamp / 1000, ZoneInfo(meta["timezone"]))
    return None


def stock_provider(db, keys, datasets, local, stamp):
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    valid_until = int((midnight + timedelta(days=1)).timestamp() * 1000)
    earliest = int((midnight - timedelta(days=14)).timestamp() * 1000)
    chosen = None
    for frame, key in keys.items():
        if key not in datasets:
            continue
        records = db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key,
            ProviderBar.start >= earliest, ProviderBar.start <= stamp)
            .order_by(ProviderBar.start.desc()).limit(MAX_POINTS)).all()
        records = [row for row in records
                   if row.complete or row.start <= stamp < row.payload["end"]]
        if not records:
            continue
        date = datetime.fromtimestamp(records[0].start / 1000, local.tzinfo).date()
        # Prefer today's coarser bars over an older fine-grained cache.
        if chosen is not None and date <= chosen[0]:
            continue
        opening = midnight.replace(year=date.year, month=date.month, day=date.day, hour=9, minute=30)
        closing = opening.replace(hour=16, minute=0)
        left, right = int(opening.timestamp() * 1000), int(closing.timestamp() * 1000)
        rows = [{**row.payload, "start": row.start, "complete": row.complete}
                for row in reversed(records) if left <= row.start < right]
        if rows:
            chosen = (date, left, right, frame, rows, {"cache_revision": datasets[key].revision})
            if date == local.date():
                break
    if chosen is None:
        left = int(midnight.replace(hour=9, minute=30).timestamp() * 1000)
        right = int(midnight.replace(hour=16).timestamp() * 1000)
        date, frame, rows, revision = local.date(), None, [], None
    else:
        date, left, right, frame, rows, revision = chosen
    return left, right, frame, rows, revision, {
        "session": {"date": date.isoformat(), "previous": date < local.date()},
        "valid_until": valid_until}


def provider(db, symbol, stamp):
    from .history_catalog import oanda_entry
    from .provider_cache import identity
    from .provider_chart import metadata

    # cached_only prevents Yahoo metadata I/O. Other metadata branches read
    # local catalogs/configuration only, including account and native parameters.
    meta = metadata(symbol, cached_only=True)
    entry = db.get(MarketCatalog, symbol)
    if entry is None and meta["source"] == "oanda":
        entry = oanda_entry(db, meta["symbol"])
    asset = meta.get("asset_type") or (entry.asset_type if entry else None)
    left, right = window(stamp, asset)
    keys = {frame: identity(meta, frame) for frame in FRAMES if frame in meta.get("frames", FRAMES)}
    datasets = {row.id: row for row in db.scalars(select(ProviderDataset).where(
        ProviderDataset.id.in_(keys.values())))}
    local = stock_clock(meta, stamp)
    if local is not None:
        return stock_provider(db, keys, datasets, local, stamp)
    for frame, key in keys.items():
        dataset = datasets.get(key)
        if dataset is None:
            continue
        records = db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key,
            ProviderBar.start >= left, ProviderBar.start < min(right, stamp + 1))
            .order_by(ProviderBar.start).limit(MAX_POINTS)).all()
        # Intraday source timestamps are authoritative; never use chart labels.
        rows = [{**row.payload, "start": row.start, "complete": row.complete}
                for row in records if row.complete or row.start <= stamp < row.payload["end"]]
        if rows:
            return left, right, frame, rows, {"cache_revision": dataset.revision}
    return left, right, None, [], None


def managed(db, symbol, stamp):
    from .chart_data import chart_rows
    from .market_data import usable_cached_rows

    instrument = db.get(Instrument, symbol)
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == symbol))
    left, right = window(stamp, dataset.asset_class if dataset else None)
    if instrument is None:
        return left, right, None, [], None
    for frame in FRAMES:
        rows = chart_rows(db, instrument, frame, min(right, stamp + 1), MAX_POINTS, stamp, after=left)
        rows, _ = usable_cached_rows(db, instrument, rows, stamp)
        if rows:
            return left, right, frame, rows, None
    return left, right, None, [], None


def history(db, symbol, stamp):
    from .history_artifacts import read_artifact
    from .history_versions import snapshot_rows

    version = db.get(HistoryVersion, symbol)
    if not version or version.status != "published":
        raise ValueError("固定历史版本尚未发布或不存在")
    dataset = db.get(MarketDataset, version.dataset_id)
    left, right = window(stamp, dataset.asset_class)
    revision = {"history_version_id": version.id}
    start, end = max(left, version.start), min(right, stamp // 60000 * 60000, version.end)
    if start >= end:
        return left, right, None, [], revision
    if version.manifest.get("schema") != "managed-period-snapshot-v2":
        rows = [{**row, "start": row["timestamp"], "end": row["timestamp"] + 60000}
                for row in islice(snapshot_rows(db, symbol, start=start, end=end), MAX_POINTS)]
        if rows:
            return left, right, "M1", rows, revision
    available = set(db.scalars(select(HistoryArtifact.timeframe).where(
        HistoryArtifact.version_id == symbol, HistoryArtifact.status == "published",
        HistoryArtifact.timeframe.in_(FRAMES))))
    for frame in FRAMES:
        if frame not in available:
            continue
        rows = read_artifact(db, symbol, frame, start=left, end=min(right, stamp + 1), limit=MAX_POINTS)
        if rows:
            return left, right, frame, rows, revision
    return left, right, None, [], revision


def composite(db, symbol, revision_id, stamp):
    from .composite_series import read_window

    definition = db.get(MarketComposite, symbol)
    if not definition or definition.permission_scope != "workspace:default":
        raise ValueError("组合行情不存在或不可访问")
    revision = db.get(CompositeRevision, revision_id or definition.active_revision_id)
    if not revision or revision.composite_id != symbol:
        raise ValueError("组合修订不属于所选行情")
    dataset = db.get(MarketDataset, definition.dataset_id)
    left, right = window(stamp, dataset.asset_class)
    # A single repeatable-read observation fixes preparation waterline and the
    # durable display overlay together. Do not create/renew a display token.
    result = read_window(db, symbol, "M1", left, right, revision_id=revision.id,
                         provisional=True, now=stamp)
    rows = [row for row in result["bars"] if row["start"] <= stamp]
    return left, right, "M1" if rows else None, rows, {
        "composite_revision_id": revision.id, "input_revision": result["input_revision"]}


def result(ticker, left, right, frame, rows, revision, stamp, session=None):
    step = FRAMES.get(frame, 60000)
    points = []
    partial = False
    previous_end = None
    for row in rows[:MAX_POINTS]:
        gap = previous_end is not None and row["start"] != previous_end
        points.append({"time": row["start"], "price": str(row["close"]), "gap_before": gap})
        partial |= gap or not row.get("complete", False) or row.get("coverage_complete") is False
        previous_end = row["end"]
    partial |= bool(points and (points[0]["time"] > left or previous_end <= stamp - step))
    status = "partial" if points and partial else "ready" if points else "empty"
    references = []
    if not session and left % 86400000:  # NY17 from explicit asset metadata.
        for zone in (ZoneInfo("Europe/London"), ZoneInfo("America/New_York")):
            local = datetime.fromtimestamp(left / 1000, zone).replace(hour=8, minute=0, second=0, microsecond=0)
            if local.timestamp() * 1000 < left:
                local += timedelta(days=1)
            at = int(local.timestamp() * 1000)
            if at < right:
                references.append(at)
    return {"ticker": ticker, "revision": revision, "window_start": left, "window_end": right,
        **(session or {}),
        "reference_times": references,
        "timeframe": frame, "points": points, "status": status,
        "reason": "当前窗口缓存含缺口或未确认观测" if status == "partial" else
                  "本机尚无当前窗口的日内缓存" if status == "empty" else None,
        "last_data_at": points[-1]["time"] if points else None}


def batch(items):
    stamp = storage.now_ms()
    output = []
    for item in items:
        try:
            symbol, kind = decode(item.ticker)
            if item.composite_revision_id is not None and kind != "composite":
                raise ValueError("仅组合行情接受组合修订")
            with storage.Session() as db:
                if db.get_bind().dialect.name == "postgresql":
                    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
                if kind == "provider":
                    values = provider(db, symbol, stamp)
                elif kind == "managed":
                    values = managed(db, symbol, stamp)
                elif kind == "history":
                    values = history(db, symbol, stamp)
                else:
                    values = composite(db, symbol, item.composite_revision_id, stamp)
                output.append(result(item.ticker, *values[:5], stamp,
                                     session=values[5] if len(values) > 5 else None))
                # No commit: even incidental ORM bookkeeping cannot persist.
        except (ValueError, QueryError, OSError, TimeoutError) as error:
            left, right = window(stamp, None)
            output.append({**result(item.ticker, left, right, None, [], None, stamp),
                "status": "unavailable", "reason": str(error)})
        except Exception as error:
            # A broken cache item must not erase the rest of the watchlist.
            # SQL/driver exceptions may include private parameters: report type only.
            log.warning("sparkline_cache_read_failed type=%s", type(error).__name__)
            left, right = window(stamp, None)
            output.append({**result(item.ticker, left, right, None, [], None, stamp),
                "status": "unavailable", "reason": "本机缓存读取失败，请稍后重试"})
    return {"as_of": stamp, "items": output}


def prepare(item):
    """Explicit visible-watch demand; reuse bounded provider history/cache readers.

    The observation endpoint remains read-only. This separate operation prepares
    the current day of intraday bars, without creating jobs or a second live poller.
    Count-based readers can cross closures; stocks may display the most recent
    actual session until current-session bars arrive.
    """
    import time

    from . import provider_cache
    from .provider_capabilities import request_seconds
    from .provider_chart import metadata

    preparation = "ready"
    try:
        symbol, kind = decode(item.ticker)
        if kind != "provider" or item.composite_revision_id is not None:
            preparation = "unsupported"
        else:
            meta = metadata(symbol, cached_only=True)
            frame = next((frame for frame in FRAMES if frame in meta.get("frames", FRAMES)), None)
            if frame is None:
                preparation = "unsupported"
            else:
                stamp = storage.now_ms()
                with storage.Session() as db:
                    entry = db.get(MarketCatalog, symbol)
                    asset = meta.get("asset_type") or (entry.asset_type if entry else None)
                    if entry is None and meta["source"] == "oanda":
                        from .history_catalog import oanda_entry
                        entry = oanda_entry(db, meta["symbol"])
                        asset = asset or (entry.asset_type if entry else None)
                left, _ = window(stamp, asset)
                step = FRAMES[frame]
                before = stamp // step * step
                count = min(MAX_POINTS, max(0, (before - left + step - 1) // step))
                if stock_clock(meta, stamp) is not None:
                    # Count actual source bars across weekends, even at 00:01.
                    count = max(count, (390 * 60000 + step - 1) // step)
                if count:
                    provider_cache.read(meta, frame, before, count, latest=False,
                        deadline=time.monotonic() + max(20, request_seconds(meta["source"])))
    except Exception as error:
        # Keep existing observations on a supplier timeout; retry on the next refresh.
        log.warning("sparkline_history_prepare_failed type=%s", type(error).__name__)
        preparation = "retry"
    return {**batch([item]), "preparation": preparation}
