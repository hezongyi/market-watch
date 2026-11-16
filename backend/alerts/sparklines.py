"""Bounded mobile sparkline observations and explicit provider history preparation.

Batch observations never write demand or bookkeeping. Only prepare() invokes the
shared provider cache writer, without registering an instrument or starting jobs.
"""

import json
import logging
from datetime import UTC, datetime, timedelta
from itertools import islice
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from . import storage
from .chart_series import decode
from .query_errors import QueryError
from .storage import (
    CompositeMinute,
    CompositeRevision,
    HistoryArtifact,
    HistoryChunk,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    ObservedMinute,
    ProviderBar,
    ProviderDataset,
    RealtimeMapping,
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


def a_share(identity):
    symbol = identity.get("provider_symbol") or identity.get("symbol", "")
    return identity.get("source") == "akshare" and symbol.split(":")[0] in {"SSE", "SZSE", "BSE"}


def display_axis(output, identity):
    """A-share display clock; never change source bars or acquisition calendars."""
    if not a_share(identity) or not output[3]:
        return output
    local = datetime.fromtimestamp(output[3][0]["start"] / 1000, ZoneInfo("Asia/Shanghai"))
    output[5]["display_segments"] = [
        {"start": int(local.replace(hour=hour, minute=minute, second=0, microsecond=0).timestamp() * 1000),
         "end": int(local.replace(hour=end_hour, minute=end_minute, second=0, microsecond=0).timestamp() * 1000)}
        for hour, minute, end_hour, end_minute in ((9, 30, 11, 30), (13, 0, 15, 0))]
    return output


LOOKBACK = 14 * 86400000


def closing_reference(candidates, left, bounds, identity=None):
    """Only a finished bar at the prior actual session's end proves its close."""
    previous = [(frame, row) for frame, rows, _ in candidates for row in rows
        if row["start"] < left and row.get("complete") and row.get("close") is not None
        and row["start"] >= left - LOOKBACK]
    latest = max((bounds(row["start"])[0] for _, row in previous), default=None)
    def finished(frame, row):
        if not a_share(identity or {}):
            return row.get("end") == bounds(row["start"])[1]
        # Native D1 uses a UTC date label and a 15:10 Shanghai confirmation
        # boundary. Intraday closes prove the close only at exactly 15:00.
        local = datetime.fromtimestamp(row["start"] / 1000, ZoneInfo("Asia/Shanghai"))
        end = int(local.replace(hour=15, minute=10 if frame == "D1" else 0,
            second=0, microsecond=0).timestamp() * 1000)
        return row.get("end") == end and end <= left
    evidence = [row for frame, row in previous if bounds(row["start"])[0] == latest and finished(frame, row)]
    row = max(evidence, key=lambda row: row["start"], default=None)
    return {"previous_close_price": str(row["close"]) if row else None,
        "previous_close_at": row["end"] if row else None}


def selection(candidates, stamp, bounds, *, stock=None, sessions=None, fixed=False, intraday=True):
    """Choose the latest actual window across frames; current coarse beats old M1.

    Source readers alone own identity, revision and bounded payload validation.
    Calendar bounds are axes; only dated source evidence proves a stock close.
    """
    target_left, target_right = bounds(stamp)
    chosen = None
    for frame, values, revision in candidates:
        values = [row for row in values if row["start"] <= stamp]
        if not values:
            continue
        left, right = bounds(values[-1]["start"])
        rows = [row for row in values if left <= row["start"] < right]
        if not rows or chosen is not None and left <= chosen[0]:
            continue
        chosen = left, right, frame, rows, revision
    left, right, frame, rows, revision = chosen or (target_left, target_right, None, [], None)
    previous = bool(rows and left != target_left)
    historical = bool(previous and right < stamp - LOOKBACK)
    date = datetime.fromtimestamp(left / 1000, stock.tzinfo if stock else UTC).date().isoformat()
    evidence = (sessions or {}).get(date)
    state = "historical" if historical else "previous" if previous else "empty" if not rows else "unknown" if stock else "current"
    if rows and not previous and evidence:
        state = "closed" if stamp >= evidence["end"] else "current" if stamp >= evidence["start"] else "unknown"
    # A display window's end is not its expiry: keep a valid fallback offline.
    valid_until = stamp + 30 * 86400000 if fixed else max(stamp + 60000, right + LOOKBACK)
    next_check = min(stamp + 60000, target_right) if target_right > stamp else stamp + 60000
    if evidence:
        next_check = min([next_check] + [at for at in (evidence["start"], evidence["end"]) if at > stamp])
    return left, right, frame, rows, revision, {
        "stock_session": bool(stock),
        "target_window_start": target_left, "target_window_end": target_right,
        "session": {"date": date, "previous": previous},
        "display_state": state if intraday else "unsupported",
        "session_open_price": str(rows[0]["open"]) if rows and rows[0]["start"] == left and rows[0].get("open") is not None else None,
        **closing_reference(candidates, left, bounds),
        "valid_until": valid_until, "next_check_at": max(stamp + 1, next_check)}


def stock_bounds(local, sessions):
    def bounds(at):
        current = datetime.fromtimestamp(at / 1000, local.tzinfo)
        evidence = sessions.get(current.date().isoformat())
        if evidence:
            return evidence["start"], evidence["end"]
        return (int(current.replace(hour=9, minute=30, second=0, microsecond=0).timestamp() * 1000),
                int(current.replace(hour=16, minute=0, second=0, microsecond=0).timestamp() * 1000))
    return bounds


def dataset_bounds(db, dataset, stamp, *, revision=None, version=None):
    instrument = db.get(Instrument, dataset.instrument_id) if dataset and revision is None else None
    phase = revision.rules.get("aggregation_calendar") if revision else (version.manifest or {}).get("aggregation_calendar") if version else None
    phase = phase or (instrument.calendar if instrument else None)
    if phase == "source_date":
        params = (dataset.identity or {}).get("parameters", {})
        zone = ZoneInfo(params.get("timezone") or "UTC")
        def bounds(at):
            local = datetime.fromtimestamp(at / 1000, zone).replace(hour=0, minute=0, second=0, microsecond=0)
            return int(local.timestamp() * 1000), int((local + timedelta(days=1)).timestamp() * 1000)
        return bounds
    asset = "forex" if phase == "ny17" else "unknown" if phase == "utc0" else dataset.asset_class if dataset else None
    return lambda at: window(at, asset)


def provider(db, symbol, stamp, meta):
    from .history_catalog import oanda_entry
    from .provider_cache import identity
    entry = db.get(MarketCatalog, symbol)
    if entry is None and meta["source"] == "oanda":
        entry = oanda_entry(db, meta["symbol"])
    asset = meta.get("asset_type") or (entry.asset_type if entry else None)
    left, right = window(stamp, asset)
    keys = {frame: identity(meta, frame) for frame in FRAMES if frame in meta.get("frames", FRAMES)}
    daily_key = identity(meta, "D1") if "D1" in meta.get("frames", ()) else None
    datasets = {row.id: row for row in db.scalars(select(ProviderDataset).where(
        ProviderDataset.id.in_([*keys.values(), *([daily_key] if daily_key else [])])))}
    local = stock_clock(meta, stamp)
    sessions = {}
    for dataset in datasets.values():
        sessions.update(dataset.metadata_json.get("sparkline_sessions") or {})
    sessions.update(meta.get("sparkline_sessions") or {})
    bounds = stock_bounds(local, sessions) if local else lambda at: window(at, asset)
    candidates = []
    for frame, key in keys.items():
        dataset = datasets.get(key)
        if dataset is None:
            continue
        records = db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key,
            ProviderBar.start >= stamp - LOOKBACK, ProviderBar.start <= stamp)
            .order_by(ProviderBar.start.desc()).limit(MAX_POINTS)).all()
        rows = [{**row.payload, "start": row.start, "complete": row.complete}
                for row in reversed(records) if row.complete or row.start <= stamp < row.payload["end"]]
        if local:
            rows = [row for row in rows if bounds(row["start"])[0] <= row["start"] < bounds(row["start"])[1]]
        candidates.append((frame, rows, {"cache_revision": dataset.revision}))
    output = selection(candidates, stamp, bounds, stock=local, sessions=sessions, intraday=bool(keys))
    if output[3]:
        # The current session may consume the entire bounded page. Read one
        # earlier finished bar using the same cache identity, not another feed.
        reference_candidates = list(candidates)
        reference_frames = list(dict.fromkeys([output[2], "D1"]))
        for frame in reference_frames:
            key = daily_key if frame == "D1" else keys.get(frame)
            if frame != "D1" and any(candidate_frame == frame and len(values) < MAX_POINTS for candidate_frame, values, _ in candidates):
                continue  # The bounded cache read already included every preceding row.
            if key not in datasets:
                continue
            prior = db.scalar(select(ProviderBar).where(ProviderBar.dataset_id == key,
                ProviderBar.start < output[0], ProviderBar.start >= output[0] - LOOKBACK,
                ProviderBar.complete.is_(True)).order_by(ProviderBar.start.desc()).limit(1))
            if prior:
                reference_candidates.append((frame, [{**prior.payload, "start": prior.start, "complete": True}], None))
        output[5].update(closing_reference(reference_candidates, output[0], bounds, meta))
    if output[3]:
        # A sparse first M1 is not the open. The native daily candle can prove
        # it, but only when its *source* interval exactly matches this axis.
        daily = db.scalar(select(ProviderBar).where(
            ProviderBar.dataset_id == daily_key, ProviderBar.start == output[0])) if daily_key in datasets else None
        if daily and daily.payload.get("end") == output[1] and daily.payload.get("open") is not None:
            output[5]["session_open_price"] = str(daily.payload["open"])
        elif output[5]["session_open_price"] is None:
            for _, values, _ in candidates:
                first = next((row for row in values if row["start"] == output[0]), None)
                if first and first.get("open") is not None:
                    output[5]["session_open_price"] = str(first["open"])
                    break
    key = keys.get(output[2]) or next(iter(keys.values()), None)
    dataset = datasets.get(key)
    # Yahoo price revalidation revokes old adjusted values without changing the
    # source's stable dataset key. Empty replies must not resurrect those prices.
    output[5]["identity_key"] = json.dumps([key, (dataset.metadata_json or {}).get("revalidation_generation", 0) if dataset else 0])
    return display_axis(output, meta)


def managed(db, symbol, stamp):
    from .chart_data import chart_rows
    from .market_data import usable_cached_rows

    instrument = db.get(Instrument, symbol)
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == symbol))
    bounds = dataset_bounds(db, dataset, stamp)
    candidates = []
    if instrument is not None:
        for frame in FRAMES:
            rows = chart_rows(db, instrument, frame, stamp + 1, MAX_POINTS, stamp, after=stamp - LOOKBACK)
            rows, _ = usable_cached_rows(db, instrument, rows, stamp)
            candidates.append((frame, rows, None))
    output = selection(candidates, stamp, bounds)
    identity = dataset.identity if dataset else {}
    if a_share(identity):
        output[5].update(closing_reference(candidates, output[0], bounds, identity))
    return display_axis(output, identity)


def latest_history_at(db, version, cutoff):
    from .history_versions import raw_chunk
    # Published partitions are indexed by version/frame/start. Two bounded
    # partitions cover the exclusive seam without scanning a calendar day loop.
    chunks = db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == version.id,
        HistoryChunk.timeframe == "M1", HistoryChunk.count > 0, HistoryChunk.start < cutoff)
        .order_by(HistoryChunk.start.desc()).limit(2))
    for chunk in chunks:
        rows = json.loads(raw_chunk(db, chunk))
        times = [row["timestamp"] for row in rows if version.start <= row["timestamp"] < cutoff]
        if times:
            return max(times)
    return None


def history(db, symbol, stamp):
    from .history_artifacts import read_artifact
    from .history_versions import snapshot_rows

    version = db.get(HistoryVersion, symbol)
    if not version or version.status != "published":
        raise ValueError("固定历史版本尚未发布或不存在")
    if db.get(HistoryReclamation, version.id):
        raise ValueError("该历史版本价格数据已回收")
    dataset = db.get(MarketDataset, version.dataset_id)
    bounds = dataset_bounds(db, dataset, stamp, version=version)
    revision = {"history_version_id": version.id}
    candidates = []
    cutoff = min(stamp // 60000 * 60000, version.end)
    if version.manifest.get("schema") != "managed-period-snapshot-v2" and cutoff > version.start:
        at = latest_history_at(db, version, cutoff)
        if at is not None:
            left, right = bounds(at)
            rows = [{**row, "start": row["timestamp"], "end": row["timestamp"] + 60000}
                for row in islice(snapshot_rows(db, symbol, start=max(version.start, left),
                    end=min(cutoff, right)), MAX_POINTS)]
            candidates.append(("M1", rows, revision))
    available = set() if candidates else set(db.scalars(select(HistoryArtifact.timeframe).where(
        HistoryArtifact.version_id == symbol, HistoryArtifact.status == "published",
        HistoryArtifact.timeframe.in_(FRAMES))))
    for frame in FRAMES:
        if frame in available:
            rows = read_artifact(db, symbol, frame, end=stamp + 1, limit=MAX_POINTS, newest_first=True)
            candidates.append((frame, rows, revision))
    output = selection(candidates, stamp, bounds, fixed=True, intraday=bool(candidates or available))
    if output[3] and output[5]["previous_close_price"] is None:
        frame = output[2]
        if version.manifest.get("schema") != "managed-period-snapshot-v2" and frame == "M1":
            at = latest_history_at(db, version, min(output[0], version.end))
            previous = [] if at is None else [{**row, "start": row["timestamp"], "end": row["timestamp"] + 60000}
                for row in islice(snapshot_rows(db, symbol, start=max(version.start, bounds(at)[0]),
                    end=min(output[0], version.end)), MAX_POINTS)]
        else:
            previous = read_artifact(db, symbol, frame, end=output[0], limit=1, newest_first=True)
        output[5].update(closing_reference([(frame, previous, revision)], output[0], bounds, dataset.identity))
    return display_axis((*output[:4], revision, output[5]), dataset.identity)


def composite(db, symbol, revision_id, stamp):
    from .composite_series import read_window

    definition = db.get(MarketComposite, symbol)
    if not definition or definition.permission_scope != "workspace:default":
        raise ValueError("组合行情不存在或不可访问")
    revision = db.get(CompositeRevision, revision_id or definition.active_revision_id)
    if not revision or revision.composite_id != symbol:
        raise ValueError("组合修订不属于所选行情")
    dataset = db.get(MarketDataset, definition.dataset_id)
    bounds = dataset_bounds(db, dataset, stamp, revision=revision)
    target_left, target_right = bounds(stamp)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    latest, observed = db.execute(select(
        select(func.max(CompositeMinute.start)).where(
            CompositeMinute.revision_id == revision.id, CompositeMinute.start <= stamp,
            CompositeMinute.start >= stamp - LOOKBACK).scalar_subquery(),
        select(func.max(ObservedMinute.start)).where(
            ObservedMinute.dataset_id == mapping.target_dataset_id,
            ObservedMinute.start >= max(revision.seam, stamp - LOOKBACK),
            ObservedMinute.start <= stamp).scalar_subquery())).one()
    choices = [at for at in (latest, observed) if at is not None]
    result = None
    rows = []
    # Indexed evidence avoids executing an expensive empty current-window read
    # before the previous-day read. read_window still validates every candidate.
    if choices and max(choices) >= target_left:
        result = read_window(db, symbol, "M1", target_left, target_right, revision_id=revision.id,
                             provisional=True, now=stamp)
        rows = [row for row in result["bars"] if row["start"] <= stamp]
    if not rows:
        version = db.get(HistoryVersion, revision.history_version_id)
        history_at = latest_history_at(db, version, min(stamp + 1, revision.seam, version.end))
        if history_at is not None:
            choices.append(history_at)
        for at in sorted(set(choices), reverse=True):
            if at < stamp - LOOKBACK:
                continue
            left, right = bounds(at)
            if result is not None and left == target_left:
                continue
            result = read_window(db, symbol, "M1", left, right, revision_id=revision.id,
                                 provisional=True, now=stamp)
            rows = [row for row in result["bars"] if row["start"] <= stamp]
            if rows:
                break
    if result is None:
        result = read_window(db, symbol, "M1", target_left, target_right, revision_id=revision.id,
                             provisional=True, now=stamp)
    marker = {"composite_revision_id": revision.id, "input_revision": result["input_revision"]}
    output = selection([("M1", rows, marker)], stamp, bounds)
    if rows:
        # Reuse the exact selected revision for both sides of the reference.
        prior = db.scalar(select(func.max(CompositeMinute.start)).where(
            CompositeMinute.revision_id == revision.id, CompositeMinute.start < output[0],
            CompositeMinute.start >= output[0] - LOOKBACK))
        observed_prior = db.scalar(select(func.max(ObservedMinute.start)).where(
            ObservedMinute.dataset_id == mapping.target_dataset_id, ObservedMinute.start < output[0],
            ObservedMinute.start >= max(revision.seam, output[0] - LOOKBACK)))
        version = db.get(HistoryVersion, revision.history_version_id)
        historical_prior = latest_history_at(db, version, min(output[0], revision.seam, version.end))
        at = max((at for at in (prior, observed_prior, historical_prior) if at is not None), default=None)
        if at is not None and at >= output[0] - LOOKBACK:
            prior_left, prior_right = bounds(at)
            prior_result = read_window(db, symbol, "M1", prior_left, prior_right,
                revision_id=revision.id, provisional=False, now=stamp)
            output[5].update(closing_reference([("M1", prior_result["bars"], marker)], output[0], bounds, dataset.identity))
    return display_axis((*output[:4], marker, output[5]), dataset.identity)


def result(ticker, left, right, frame, rows, revision, stamp, session=None):
    step = FRAMES.get(frame, 60000)
    points = []
    partial = False
    previous_end = None
    for row in rows[:MAX_POINTS]:
        gap = previous_end is not None and row["start"] != previous_end
        points.append({"time": row["start"], "price": str(row["close"]), "gap_before": gap,
                       # Minute prices are closes. Keep their source start for
                       # identity/deduplication, place them at the observed end.
                       **({"display_time": min(row["end"], stamp)} if (session or {}).get("display_segments") else {})})
        partial |= gap or not row.get("complete", False) or row.get("coverage_complete") is False
        previous_end = row["end"]
    partial |= bool(points and (points[0]["time"] > left or previous_end <= stamp - step))
    status = "partial" if points and partial else "ready" if points else "empty"
    references = []
    if left % 86400000 and not (session or {}).get("stock_session") and not (session or {}).get("display_segments"):
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
        "reason": "此品种没有日内产物" if (session or {}).get("display_state") == "unsupported" else
                  "所示窗口缓存含缺口或未确认观测" if status == "partial" else
                  "本机尚无可展示的日内缓存" if status == "empty" else None,
        "last_data_at": points[-1]["time"] if points else None}


def batch(items):
    from .provider_chart import metadata

    stamp = storage.now_ms()
    output = []
    for item in items:
        try:
            symbol, kind = decode(item.ticker)
            if item.composite_revision_id is not None and kind != "composite":
                raise ValueError("仅组合行情接受组合修订")
            # Metadata has its own short catalog transaction. Resolve it before
            # checking out the snapshot connection, so concurrent reads cannot
            # each hold a connection while waiting for a second one.
            meta = metadata(symbol, cached_only=True) if kind == "provider" else None
            with storage.Session() as db:
                if db.get_bind().dialect.name == "postgresql":
                    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
                if kind == "provider":
                    values = provider(db, symbol, stamp, meta)
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
    preparation_error = None
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
                if stock_clock(meta, stamp) is not None:
                    from .sparkline_calendar import refresh
                    refresh(symbol, meta, stamp)
                left, right = window(stamp, asset)
                step = FRAMES[frame]
                before = stamp // step * step
                count = min(MAX_POINTS, max((right - left + step - 1) // step, (before - left + step - 1) // step))
                if stock_clock(meta, stamp) is not None:
                    # Count actual source bars across weekends, even at 00:01.
                    count = max(count, (390 * 60000 + step - 1) // step)
                if count:
                    provider_cache.read(meta, frame, before, count, latest=False,
                        deadline=time.monotonic() + max(20, request_seconds(meta["source"])))
                observed = batch([item])["items"][0]
                if observed["points"] and observed.get("previous_close_price") is None:
                    # Fetch the close *before the displayed day*. A fallback
                    # Friday curve needs Thursday's close, not Friday's open.
                    from .provider_chart import label
                    reference_frame = "D1" if ("D1" in meta.get("frames", ()) and
                        (a_share(meta) or meta["source"] == "oanda" or meta["source"] == "binance" and
                         observed["window_start"] % 86400000 == 0)) else frame
                    provider_cache.fetch_page(provider_cache.ensure(meta, reference_frame), meta, reference_frame,
                        label(observed["window_start"], reference_frame, meta["calendar"]), 3,
                        time.monotonic() + max(20, request_seconds(meta["source"])), revalidate=True)
                if observed["points"] and observed.get("session_open_price") is None and "D1" in meta.get("frames", ()):
                    # NY-aligned OANDA and UTC Binance have daily candles with
                    # this exact source interval. Dukascopy's UTC day cannot
                    # supply an NY17 open; never substitute that day's UTC open.
                    compatible = (meta["source"] == "oanda" or
                        meta["source"] == "binance" and observed["window_start"] % 86400000 == 0)
                    if compatible:
                        from .provider_chart import label
                        try:
                            # An exact reference has a fixed date. Generic high-
                            # period read may legally return an older cached day
                            # after clamping to its last observable source label.
                            provider_cache.fetch_page(provider_cache.ensure(meta, "D1"), meta, "D1",
                                label(observed["window_start"], "D1", meta["calendar"]) + 1,
                                1, time.monotonic() + max(20, request_seconds(meta["source"])), revalidate=True)
                        except Exception as error:
                            log.warning("sparkline_reference_prepare_failed type=%s", type(error).__name__)
    except Exception as error:
        # Keep existing observations on a supplier timeout; retry on the next refresh.
        log.warning("sparkline_history_prepare_failed type=%s", type(error).__name__)
        preparation = "retry"
        preparation_error = "历史补取暂未成功，稍后重试"
    response = batch([item])
    for row in response["items"]:
        row["preparation_error"] = preparation_error
    if preparation == "ready" and not any(row["points"] for row in response["items"]):
        preparation = "retry"
    return {**response, "preparation": preparation, "preparation_error": preparation_error}
