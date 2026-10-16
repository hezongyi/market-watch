"""Bounded chart-only native-period reads; never write managed candles or coverage."""

import copy
import hashlib
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from datetime import UTC, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException

from .chart_data import FRAMES, bounds
from .config import settings
from .domain import Calendar, session_bounds
from .provider_capabilities import SOURCES, fresh_seconds, versions
from .provider_capabilities import frames as source_frames
from .provider_deadline import request_deadline
from .provider_transport import (
    TIMINGS,
    activity,
    binance_get,
    discard_client,
    pooled_client,
    record_timing,
    retryable_network_error,
    warm_connections,
)
from .provider_transport import close_clients as close_clients
from .storage import Instrument, MarketCatalog, MarketDataset, instant, ms, now_ms, transaction
from .volume import encoded
from .volume import metadata as volume_metadata

OANDA_FRAMES = {**{f: f for f in FRAMES}, "D1": "D", "W1": "W", "MN": "M"}
BINANCE_FRAMES = dict(zip(FRAMES, ("1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M")))
FRAME_MS = dict(
    zip(
        FRAMES, (60000, 300000, 900000, 1800000, 3600000, 14400000, 86400000, 604800000, 2678400000)
    )
)
ALIGNMENT_VERSION = "native-bid-ny17-sunday-v1"
PAYLOAD_VERSION = "volume-v1"
_LOCK = threading.Lock()
_CACHE = OrderedDict()
_INFLIGHT = {}
_QUOTE_LAST = OrderedDict()
# Independent slots: an older chart page cannot occupy the latest-candle slot.
# Worker-wide realtime reservations are enforced by the maintenance scheduler.
_HISTORY_SLOTS = {source: threading.BoundedSemaphore(1) for source in SOURCES}
_LATEST_SLOTS = {source: threading.BoundedSemaphore(2) for source in SOURCES}
_QUOTE_SLOTS = {source: threading.BoundedSemaphore(1) for source in SOURCES}


def warm_clients():
    """Establish transport before readiness; never prefetch/cache candle data."""
    from concurrent.futures import ThreadPoolExecutor

    def connect(source):
        client = pooled_client(source)
        try:
            with activity(client) as client:
                warm_connections(client, source)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            discard_client(client)
        except httpx.HTTPError:
            # Offline startup remains available; actual chart reads report
            # errors and use their bounded retry rather than fake cached bars.
            pass

    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(connect, ("oanda", "binance")))


def metadata(ident, *, deadline=None, cached_only=False):
    if ident.startswith("NATIVE:"):
        from .native_series import configured_metadata
        try:
            return configured_metadata("NATIVE:" + ident[7:].lower())
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
    if ident.startswith("DUKA:"):
        from .provider_dukascopy import metadata as dukascopy_metadata
        return dukascopy_metadata(ident)
    if ident.startswith("YAHOO:"):
        from .provider_cache import DEADLINE
        from .yahoo_catalog import chart_metadata
        return chart_metadata(ident, deadline=deadline or DEADLINE.get(), cached_only=cached_only)
    with transaction() as db:
        from sqlalchemy import select

        if db.scalar(select(MarketDataset.id).where(MarketDataset.instrument_id == ident)):
            raise HTTPException(422, "显式数据集仅支持自建系列，不转换为平台原生身份")
        entry = db.get(MarketCatalog, ident)
        if entry is None and ident.startswith("OANDA:"):
            from .history_catalog import account_scope
            entry = next((row for row in db.scalars(select(MarketCatalog).where(
                MarketCatalog.source == "oanda", MarketCatalog.symbol == ident[6:],
                MarketCatalog.id.startswith("HC:")))
                if row.metadata_json.get("history_account_scope") == account_scope()), None)
        if entry and entry.id.startswith("HC:") and not ident.startswith("OANDA:"):
            raise HTTPException(422, "自建来源目录仅用于登记历史，不作为平台原生身份")
        inst = db.get(Instrument, ident)
        if entry:
            if not entry.available:
                raise HTTPException(422, "此品种已不在当前账户目录中")
            source, symbol, label = entry.source, entry.symbol, entry.label
            calendar, precision = entry.calendar, entry.precision
        elif inst:
            source, symbol, label = inst.source, inst.symbol, inst.label
            calendar, precision = inst.calendar, inst.precision
            if ident in ("EURUSD", "XAUUSD") and settings.fx_source == "oanda":
                source = "oanda"
                symbol = {"EURUSD": "EUR_USD", "XAUUSD": "XAU_USD"}[ident]
        else:
            raise HTTPException(404, "未知品种，请刷新品种目录")
    if source not in ("oanda", "binance") or calendar not in ("ny17", "utc0"):
        raise HTTPException(422, "该品种的平台周期或交易日历尚未接入")
    from .market_names import display_code
    result = {
        "id": ident,
        "display_symbol": display_code(symbol, source),
        "symbol": symbol,
        "name": label,
        "source": source,
        "basis": "bid" if source == "oanda" else "last",
        "calendar": calendar,
        "precision": precision,
        "frames": FRAMES,
        "series_kind": "provider",
        **volume_metadata(source, symbol),
    }
    if source == "oanda":
        from .native_series import DEFAULTS
        result["native_parameters"] = dict(DEFAULTS)
        result["calendar_version"] = settings.oanda_calendar_version
        result["calendar_profile"] = settings.oanda_calendar_profiles.get(symbol)
        result["calendar_verified"] = bool(settings.oanda_calendar_verified and result["calendar_profile"])
    return result


def label(start, frame, calendar):
    if frame not in ("D1", "W1", "MN"):
        return start
    moment = instant(start)
    if calendar == "ny17":
        # Session open 17:00 is attributed to the following trading date.
        moment = moment.astimezone(ZoneInfo("America/New_York")) + timedelta(hours=7)
    day = moment.date()
    if frame == "MN":
        day = day.replace(day=1)
    return ms(instant(0).replace(year=day.year, month=day.month, day=day.day))


def _request(client, url, *, params, headers=None, deadline):
    source = "oanda" if "oanda.com" in url else "binance"
    if source == "binance":
        response = binance_get(client, url, params=params, headers=headers, deadline=deadline)
        decode_started = time.monotonic()
        with request_deadline(deadline):
            payload = response.json()
        record_timing("upstream_decode", decode_started)
        return payload
    max_attempts = 3 if source == "oanda" else 2
    for attempt in range(max_attempts):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("平台请求超过时间预算")
        try:
            from .market_resources import request_slot

            slot_started = time.monotonic()
            with request_slot(source, deadline=deadline):
                record_timing("upstream_slot", slot_started)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("平台请求超过时间预算")
                http_started = time.monotonic()
                phases = {}
                def trace(name, info):
                    stage, _, event = name.rpartition(".")
                    if event == "started":
                        phases[stage] = time.monotonic()
                    elif event in ("complete", "failed") and stage in phases:
                        record_timing("network_" + stage.replace(".", "_"), phases.pop(stage))
                try:
                    with activity(client) as client, request_deadline(deadline):
                        timings = TIMINGS.get()
                        if timings is not None:
                            attempts = timings.setdefault("candles_attempts", [])
                            attempt_record = {"attempt": attempt + 1}
                            attempts.append(attempt_record)
                        response = client.get(
                            url, params=params, headers=headers, timeout=min(7, remaining),
                            extensions={"trace": trace},
                        )
                        if timings is not None:
                            attempt_record["status"] = response.status_code
                except Exception as error:
                    if TIMINGS.get() is not None and 'attempt_record' in locals():
                        attempt_record["error"] = type(error).__name__
                    raise
                finally:
                    record_timing("upstream_http", http_started)
            if (response.status_code not in (429, 502, 503, 504) or attempt == max_attempts-1
                    or source == "binance" and response.status_code == 429):
                response.raise_for_status()
                decode_started = time.monotonic()
                payload = response.json()
                record_timing("upstream_decode", decode_started)
                return payload
        except httpx.TransportError as error:
            record_timing("failure_" + type(error).__name__, http_started)
            if not retryable_network_error(error) or (
                    source == "oanda" and not isinstance(error, (httpx.ConnectError, httpx.TimeoutException))):
                raise
            if source == "binance" or isinstance(error, (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)):
                discard_client(client)
            if attempt == max_attempts-1:
                raise
        # A bounded retry leaves failure distinguishable from a history boundary.
        remaining = deadline - time.monotonic()
        delay = 0.25 * 2**attempt
        if remaining <= delay:
            raise TimeoutError("平台请求超过时间预算")
        time.sleep(delay)
    raise RuntimeError("平台请求重试耗尽")


def _end(start, frame, calendar):
    moment = instant(start)
    zone = ZoneInfo("America/New_York") if calendar == "ny17" else UTC
    if frame == "MN":
        return ms(bounds(moment, frame, Calendar(calendar))[1])
    if frame in ("D1", "W1"):
        return ms(moment.astimezone(zone) + timedelta(days=1 if frame == "D1" else 7))
    return start + FRAME_MS[frame]


def native_page(meta, frame, before, count, *, client=None, deadline=None, optional=0):
    """Return upstream native OHLC, exclusive chart labels and an explicit boundary."""
    if meta["source"] == "yahoo":
        from .provider_yahoo import native_page as yahoo_page
        return yahoo_page(meta, frame, before, count, deadline=deadline, optional=optional)
    if meta["source"] == "dukascopy":
        from .provider_dukascopy import native_page as dukascopy_page
        return dukascopy_page(meta, frame, before, count, client=client, deadline=deadline, optional=optional)
    if frame not in source_frames(meta["source"]) or not 1 <= count <= (4000 if meta["source"] == "oanda" else 1000):
        raise ValueError("无效平台周期或根数")
    source = meta["source"]
    deadline = deadline or time.monotonic() + 20
    client = client or pooled_client(source)
    rows = []
    # Buffer only translates session timestamps to exclusive trading-date labels.
    observed = now_ms()
    high_period = frame in ("D1", "W1", "MN")
    cursor = min(observed + 1, before + (2 * 86400000 if high_period else 0))
    boundary = False
    for _ in range(8):
        # Optional bars can fill this mandatory HTTP request, but never extend
        # the loop. High-period translation/filtering still stops at count.
        batch_count = min(
            4000 if source == "oanda" else 1000,
            count - len(rows) + optional + (3 if frame in ("D1", "W1", "MN") else 0),
        )
        if source == "oanda":
            from .native_series import chart_label, interval_end, parameters
            native = parameters(meta)
            if not settings.oanda_token:
                raise ValueError("OANDA认证未配置")
            payload = _request(
                client,
                f"https://api-fxpractice.oanda.com/v3/instruments/{meta['symbol']}/candles",
                params={
                    "granularity": OANDA_FRAMES[frame],
                    **native,
                    "smooth": str(native["smooth"]).lower(),
                    "count": batch_count,
                    # Let OANDA choose its current cutoff. A local-now `to`
                    # can be rejected when its clock is slightly behind ours.
                    **({} if high_period and cursor >= observed else
                       {"to": str(Decimal(cursor) / 1000)}),
                },
                headers={
                    "Authorization": "Bearer " + settings.oanda_token,
                    "Accept-Datetime-Format": "UNIX",
                },
                deadline=deadline,
            )
            candles = payload["candles"]
            batch = []
            for candle in candles:
                start = int(Decimal(candle["time"]) * 1000)
                prices = candle[{"B": "bid", "A": "ask", "M": "mid"}[native["price"]]]
                batch.append(
                    {
                        "start": start,
                        "end": interval_end(start, frame, native),
                        "chart_time": chart_label(start, frame, native),
                        "complete": bool(candle["complete"]),
                        "volume": encoded(candle.get("volume"), tick=True),
                        "volume_complete": bool(candle["complete"] and candle.get("volume") is not None),
                        **{
                            k: prices[v]
                            for k, v in (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c"))
                        },
                    }
                )
        else:
            candles = _request(
                client,
                "https://data-api.binance.vision/api/v3/klines",
                params={
                    "symbol": meta["symbol"],
                    "interval": BINANCE_FRAMES[frame],
                    "endTime": cursor - 1,
                    "limit": batch_count,
                },
                deadline=deadline,
            )
            batch = [
                {
                    "start": int(c[0]),
                    "end": int(c[6]) + 1,
                    "chart_time": label(int(c[0]), frame, "utc0"),
                    "complete": int(c[6]) < now_ms(),
                    "volume": encoded(c[5]),
                    "volume_complete": int(c[6]) < now_ms() and c[5] is not None,
                    **dict(zip(("open", "high", "low", "close"), c[1:5])),
                }
                for c in candles
            ]
        boundary = len(batch) < batch_count
        rows = sorted(
            {b["start"]: b for b in batch + rows
             if b["chart_time"] < before and (source != "oanda" or b["start"] <= observed)}.values(),
            key=lambda b: b["start"],
        )
        if boundary or len(rows) >= count:
            break
        next_cursor = min(b["start"] for b in batch)
        if next_cursor >= cursor:
            raise ValueError("平台分页未推进")
        cursor = next_cursor
    else:
        raise ValueError("平台分页超过请求上限")
    visible = rows[-(count + optional):]
    exhausted = boundary and len(rows) <= count + optional
    proven_start = 0 if exhausted else visible[0]["chart_time"] if visible else before
    return {
        "bars": visible,
        "has_more": not boundary or len(rows) > count,
        "history_boundary": exhausted,
        "coverage": [[proven_start, before]] if proven_start < before else [],
        "boundary_evidence": {
            "source": source,
            "mode": "count_latest" if source == "oanda" and high_period and cursor >= observed else "count_to",
            "returned": len(batch),
            "requested": batch_count,
        }
        if exhausted
        else None,
        "series_kind": "provider",
        **volume_metadata(source, meta["symbol"]),
        "basis": meta["basis"],
        **({"native_parameters": native} if source == "oanda" else {}),
        "calendar": meta["calendar"],
        "precision": meta["precision"],
        "indicators": [],
        "as_of": now_ms(),
    }


def cached_page(meta, frame, before, count, *, latest=False, quote=False, deadline=None, cache_seconds=None):
    deadline = deadline or time.monotonic() + 23
    # In REST-batch mode an active native subscription is owned by the shared
    # account worker. Do not let a foreground latest/quote read open a second
    # single-instrument OANDA request while that owner is refreshing the
    # ProviderDataset cache. Historical reads without an active subscription
    # retain their bounded page path.
    if meta["source"] == "oanda" and settings.oanda_acquisition_mode == "rest_batch" and latest:
        from sqlalchemy import select

        from .provider_cache import HistoryPending, snapshot_transaction
        from .provider_cache import ensure as ensure_cache
        from .storage import ProviderInterest, now_ms, transaction

        dataset_id = ensure_cache(meta, frame)
        with transaction() as db:
            active = db.scalar(select(ProviderInterest.id).where(
                ProviderInterest.dataset_id == dataset_id,
                ProviderInterest.subscribed.is_(True),
                ProviderInterest.expires > now_ms(),
            )) is not None
        if active:
            with snapshot_transaction(dataset_id, before, count) as (_, cached):
                fresh = now_ms() - cached["latest_at"] < fresh_seconds("oanda") * 1000
                if cached["bars"] and fresh:
                    return {
                        **cached,
                        "bars": cached["bars"][-count:],
                        "series_kind": "provider",
                        "basis": meta["basis"],
                        "calendar": meta["calendar"],
                        "precision": meta["precision"],
                        "dataset_id": dataset_id,
                        "cache_hit": True,
                        "indicators": [],
                    }
            raise HistoryPending()
    from .market_calendar import observation_identity

    identity = observation_identity(meta["source"], meta["symbol"], meta)
    namespace = tuple(identity.get(key) for key in (
        "source", "channel", "environment", "provider_symbol", "account_scope"))
    key = (
        meta["source"],
        namespace,
        meta["id"],
        "provider",
        frame,
        meta["basis"],
        meta["calendar"],
        *versions(meta),
        before,
        count,
        quote,
    )
    with _LOCK:
        cached = _CACHE.get(key)
        if cached and time.monotonic() < cached[0]:
            _CACHE.move_to_end(key)
            return copy.deepcopy(cached[1])
        future = _INFLIGHT.get(key)
        owner = future is None
        if owner:
            future = Future()
            _INFLIGHT[key] = future
    if not owner:
        return copy.deepcopy(future.result(timeout=max(0, deadline - time.monotonic())))
    slot = (_QUOTE_SLOTS if quote else _LATEST_SLOTS if latest else _HISTORY_SLOTS)[meta["source"]]
    acquired = False
    try:
        acquired = slot.acquire(timeout=max(0, deadline - time.monotonic()))
        if not acquired:
            raise HTTPException(503, "平台行情请求繁忙，请稍后重试")
        from .market_resources import lane

        with lane("history" if quote else "chart"):
            page = native_page(meta, frame, before, count, deadline=deadline)
        with _LOCK:
            ttl = cache_seconds if cache_seconds is not None else (15 if quote else 1 if latest else 300)
            _CACHE[key] = (time.monotonic() + ttl, page)
            while len(_CACHE) > 128 or sum(len(v[1]["bars"]) for v in _CACHE.values()) > 100000:
                _CACHE.popitem(last=False)
        future.set_result(page)
        return copy.deepcopy(page)
    except Exception as exc:
        future.set_exception(exc)
        raise
    finally:
        if acquired:
            slot.release()
        with _LOCK:
            _INFLIGHT.pop(key, None)


def quote_page(meta):
    # Native details, list and initial header can issue overlapping quote reads.
    # One polling window shares a current M1 acquisition, not a managed candle.
    before = (now_ms() // 15000) * 15000 + 1
    from .market_calendar import observation_identity

    identity = observation_identity(meta["source"], meta["symbol"], meta)
    key = (meta["source"], meta["id"], meta["basis"], meta.get("calendar"),
           meta.get("calendar_version"), identity.get("channel"),
           identity.get("environment"), identity.get("account_scope"))
    try:
        page = cached_page(meta, "M1", before, 1, latest=True, quote=True)
    except Exception:
        with _LOCK:
            previous = _QUOTE_LAST.get(key)
        if previous is None:
            raise
        return {**copy.deepcopy(previous), "fetch_status": "fetch_failed",
                "read_at": now_ms()}
    with _LOCK:
        _QUOTE_LAST[key] = copy.deepcopy(page)
        _QUOTE_LAST.move_to_end(key)
        while len(_QUOTE_LAST) > 128:
            _QUOTE_LAST.popitem(last=False)
    return {**page, "fetch_status": "ok", "read_at": page.get("as_of")}


def quote_previous_close(meta, latest):
    """Previous completed native session close, with the same price basis."""
    if meta["source"] == "oanda":
        from .native_series import chart_label, parameters, session_start
        native = parameters(meta)
        current_label = chart_label(session_start(latest["start"], native), "D1", native)
        session_boundary = session_start(latest["start"], native)
        page = cached_page(meta, "D1", current_label, 2, quote=True, cache_seconds=300)
        complete = [bar for bar in page["bars"] if bar["complete"] and bar["end"] <= session_boundary]
        return Decimal(complete[-1]["close"]) if complete else None
    current_label = label(latest["start"], "D1", meta["calendar"])
    session_start = (latest["start"] // 86400000 * 86400000 if meta["source"] == "dukascopy" else
        ms(session_bounds(instant(latest["start"]), Calendar(meta["calendar"]))[0]))
    page = cached_page(meta, "D1", current_label, 2, quote=True, cache_seconds=300)
    complete = [bar for bar in page["bars"] if bar["complete"] and bar["end"] <= session_start]
    return Decimal(complete[-1]["close"]) if complete else None


def data(body):
    from .provider_cache import data as cached_data

    return cached_data(body)


_EARLIEST = OrderedDict()


def earliest_m1(meta, *, client=None):
    """Probe the actual first native M1; never infer it from an empty time slice."""
    from .market_resources import lane

    if meta.get("native_series_id") or meta["source"] in ("yahoo", "dukascopy"):
        raise ValueError("此平台身份不建立自建维护任务，请在数据中心明确添加来源历史")
    namespace = (
        hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
        if meta["source"] == "oanda"
        else "yahoo-anonymous" if meta["source"] == "yahoo" else "binance-public"
    )
    key = (meta["source"], namespace, meta["id"], meta["basis"], ALIGNMENT_VERSION)
    with _LOCK:
        cached = _EARLIEST.get(key)
        if cached and time.monotonic() < cached[0]:
            return cached[1]
    owns = client is None
    client = client or httpx.Client(
        timeout=7,
        proxy=(
            settings.oanda_proxy if meta["source"] == "oanda" else settings.effective_binance_proxy
        )
        or None,
        trust_env=False,
    )
    try:
        with lane("history"):
            if meta["source"] == "oanda":
                result = _request(
                    client,
                    f"https://api-fxpractice.oanda.com/v3/instruments/{meta['symbol']}/candles",
                    # OANDA interprets from=0 as omitted. Positive epoch+1s is
                    # essential: otherwise this would report the latest candle.
                    params={
                        "granularity": "M1",
                        "price": "B",
                        "smooth": "false",
                        "from": "1",
                        "count": 1,
                    },
                    headers={
                        "Authorization": "Bearer " + settings.oanda_token,
                        "Accept-Datetime-Format": "UNIX",
                    },
                    deadline=time.monotonic() + 23,
                )
                candles = result.get("candles", [])
                earliest = int(Decimal(candles[0]["time"]) * 1000) if candles else None
            else:
                candles = _request(
                    client,
                    "https://data-api.binance.vision/api/v3/klines",
                    params={"symbol": meta["symbol"], "interval": "1m", "startTime": 1, "limit": 1},
                    deadline=time.monotonic() + 23,
                )
                earliest = int(candles[0][0]) if candles else None
        if earliest is None or earliest < 0 or earliest % 60000:
            raise ValueError("尚未确认该品种最早可用M1，未建立维护任务")
        with _LOCK:
            _EARLIEST[key] = (time.monotonic() + 86400, earliest)
            while len(_EARLIEST) > 250:
                _EARLIEST.popitem(last=False)
        return earliest
    finally:
        if owns:
            client.close()
