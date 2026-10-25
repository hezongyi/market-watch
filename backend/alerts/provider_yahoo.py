"""Bounded Yahoo SDK operations; native intervals, source labels and error evidence."""

import hashlib
import json
import logging
import math
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf
from curl_cffi import requests
from yfinance.data import YfData
from yfinance.exceptions import YFPricesMissingError, YFRateLimitError

from .config import settings
from .provider_capabilities import YAHOO_INTERVALS, history_policy
from .storage import instant, now_ms

_LOCK = threading.Lock()
_SESSION = None
_LAST_START = 0.0
# Yahoo's exchange table (2026-10-03) still declares 30 minutes; quote snapshots
# currently report 10. Preserve both observations, use the conservative label.
_EXCHANGE_DELAY = {"CMX": 1800, "NYM": 1800}
_US_EQUITY = {"NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS", "BATS", "PNK", "OEM"}


class YahooError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class _Session(requests.Session):
    """One absolute budget across cookie, crumb, redirects and all SDK retries."""

    deadline = 0
    rate_limited = False
    retry_after = None
    last_status = None
    chart_response = None

    def request(self, method, url, **kwargs):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Yahoo 请求超过时间预算")
        kwargs["timeout"] = min(float(kwargs.get("timeout", 10)), remaining)
        # Set on every HTTP request: SDK cookie strategies also use this session.
        kwargs["proxies"] = self.proxies
        started = time.monotonic()
        try:
            response = super().request(method, url, **kwargs)
        finally:
            from .provider_chart import record_timing
            category = ("authentication" if 'getcrumb' in url or 'fc.yahoo.com' in url or 'consent' in url
                        else "history" if '/v8/finance/chart/' in url
                        else "search" if '/finance/search' in url else "metadata_quote")
            record_timing("yahoo_" + category, started)
        self.last_status = response.status_code
        if "/v8/finance/chart/" in url:
            try:
                payload = response.json()
                chart = payload.get("chart", {})
                self.chart_response = (
                    response.status_code,
                    {
                        "chart": {
                            "error": chart.get("error"),
                            "result": [
                                {"meta": item.get("meta", {}), "timestamp": item.get("timestamp")}
                                for item in chart.get("result") or []
                            ],
                        }
                    },
                )
            except ValueError:
                self.chart_response = None
        if response.status_code == 429:
            self.rate_limited = True
            self.retry_after = response.headers.get("Retry-After")
            raise YFRateLimitError()
        return response


def sdk_session():
    """Called only under the SDK operation lock; the transport owns shutdown."""
    global _SESSION
    proxy = settings.effective_yahoo_proxy
    if not proxy:
        raise YahooError("configuration", "Yahoo 代理未配置")
    if _SESSION is None or _SESSION.proxies.get("https") != proxy:
        if _SESSION is not None:
            _SESSION.close()
        _SESSION = _Session(
            impersonate="chrome", trust_env=False, proxies={"http": proxy, "https": proxy}
        )
    return _SESSION


def close_session():
    global _SESSION
    with _LOCK:
        if _SESSION is not None:
            _SESSION.close()
            _SESSION = None


def _retry_seconds(value):
    try:
        return max(1, int(value))
    except (ValueError, TypeError):
        try:
            return max(1, int(parsedate_to_datetime(value).timestamp() - time.time()))
        except (ValueError, TypeError, OverflowError):
            return None


@contextmanager
def _operation(deadline, *, stage="request"):
    global _LAST_START
    if not settings.yahoo_enabled:
        raise YahooError("disabled", "Yahoo 行情源未启用")
    if not settings.effective_yahoo_proxy:
        raise YahooError("configuration", "Yahoo 代理未配置")
    if not _LOCK.acquire(timeout=max(0, deadline - time.monotonic())):
        raise TimeoutError("Yahoo 操作繁忙，请重试")
    try:
        from .market_resources import LANE, cooldown, lane, request_slot

        delay = max(0, 1 - (time.monotonic() - _LAST_START))
        if time.monotonic() + delay >= deadline:
            raise TimeoutError("Yahoo 操作超过时间预算")
        if delay:
            time.sleep(delay)
        with lane(LANE.get() or "chart"), request_slot("yahoo", deadline=deadline):
            _LAST_START = time.monotonic()
            session = sdk_session()
            session.deadline = deadline
            session.rate_limited = False
            session.last_status = None
            session.chart_response = None
            session.retry_after = None
            # A fresh Ticker avoids info/fast_info caches; clear the shared SDK
            # historical response LRU as well so revision checks reach upstream.
            yf.config.network.proxy = settings.effective_yahoo_proxy
            yf.config.network.retries = 0
            yf.config.debug.hide_exceptions = False
            logging.getLogger("yfinance").setLevel(logging.CRITICAL)
            YfData(session=session).cache_get.cache_clear()
            from .provider_cache import check_cancelled

            check_cancelled()
            if LANE.get() == "history":
                from .provider_cache import interactive_busy

                if interactive_busy("yahoo"):
                    raise TimeoutError("Yahoo 预热已让位于前台请求")
            try:
                yield session
                if session.rate_limited:
                    raise YFRateLimitError()
                if time.monotonic() >= deadline:
                    raise TimeoutError("Yahoo 请求超过时间预算")
            except Exception as error:
                # Only bounded type/phase/status identifiers; no URL, exception
                # text, cookies, credentials or user-supplied instrument.
                logging.getLogger(__name__).warning(
                    "yahoo_operation_failed attempt_id=%s stage=%s exception_class=%s upstream_status=%s",
                    uuid.uuid4().hex, stage, type(error).__name__, session.last_status,
                )
                if session.rate_limited or isinstance(error, YFRateLimitError):
                    cooldown("yahoo", retry_seconds=_retry_seconds(session.retry_after))
                    raise YahooError("rate_limited", "Yahoo 限流，已进入源级冷却") from None
                if isinstance(error, (YahooError, TimeoutError, YFPricesMissingError)):
                    raise
                if session.last_status in (401, 403):
                    raise YahooError("authentication", "Yahoo 认证或访问被拒绝，请重试") from None
                raise YahooError("request_failed", "Yahoo 代理或网络请求失败，请重试") from None
    finally:
        _LOCK.release()


def stable_id(symbol):
    return "YAHOO:" + hashlib.sha256(symbol.strip().upper().encode()).hexdigest()[:32]


def allowed(info):
    kind = info.get("quoteType")
    symbol = str(info.get("symbol") or "").upper()
    exchange = info.get("exchange")
    if kind not in {"INDEX", "ETF", "EQUITY", "CURRENCY", "FUTURE"}:
        return False
    if kind in {"EQUITY", "ETF"}:
        return exchange in _US_EQUITY and not symbol.endswith((".HK", ".SS", ".SZ", ".BJ"))
    return True


def display_precision(details):
    """Presentation only; never round observations or change data precision."""
    hint = details.get("price_hint")
    precision = hint if type(hint) is int and 0 <= hint <= 8 else (
        5 if details.get("asset_type") == "CURRENCY" else 2)
    price = details.get("regular_market_price")
    if type(price) in (int, float) and math.isfinite(price) and 0 < abs(price) < 1:
        # Keep small quoted prices readable instead of showing them as 0.00.
        precision = max(precision, math.ceil(-math.log10(abs(price))) + 2)
    return min(8, precision)


def _metadata(info):
    if not allowed(info):
        raise YahooError("unsupported", "该品种不在 Yahoo 首期范围内")
    symbol = info["symbol"].upper()
    kind = info["quoteType"]
    timezone = info.get("exchangeTimezoneName")
    exchange = info.get("exchange")
    session = None
    if timezone == "America/New_York" and kind in {"EQUITY", "ETF", "INDEX"}:
        session = "0930-1600:23456"
    elif exchange in {"CMX", "NYM"}:
        session = "1800-1700:23456"
    elif kind == "CURRENCY":
        # Yahoo's London labels are source labels, never OANDA NY17 buckets.
        session = "0000-0000:23456"
    raw_delay = info.get("exchangeDataDelayedBy")
    reported = int(raw_delay) * 60 if raw_delay is not None else None
    declared = _EXCHANGE_DELAY.get(exchange)
    delay = (
        max(reported or 0, declared or 0) if reported is not None or declared is not None else None
    )
    adjustment = "auto" if kind in {"EQUITY", "ETF"} else "supplier"
    events = {
        k: info[k]
        for k in (
            "exDividendDate",
            "lastDividendDate",
            "lastDividendValue",
            "lastSplitDate",
            "lastSplitFactor",
        )
        if info.get(k) is not None
    }
    first = info.get("firstTradeDateMilliseconds")
    return {
        "symbol": symbol,
        "english_name": info.get("longName") or info.get("shortName") or symbol,
        "asset_type": kind,
        "quote_type": kind,
        "exchange": info.get("fullExchangeName") or exchange,
        "exchange_code": exchange,
        "currency": info.get("currency"),
        "price_hint": info.get("priceHint") if type(info.get("priceHint")) is int
            and 0 <= info["priceHint"] <= 8 else None,
        "regular_market_price": info.get("regularMarketPrice")
            if type(info.get("regularMarketPrice")) in (int, float)
            and math.isfinite(info["regularMarketPrice"]) else None,
        "timezone": timezone,
        "session": session,
        "session_status": "configured" if session else "unknown",
        "frames": list(YAHOO_INTERVALS),
        "adjustment": adjustment,
        "price_description": "Yahoo 自动复权" if adjustment == "auto" else "Yahoo 供应商价格",
        "delay_seconds": delay,
        "reported_delay_seconds": reported,
        "declared_delay_seconds": declared,
        "first_trade_ms": first,
        "event_revision": hashlib.sha256(json.dumps(events, sort_keys=True).encode()).hexdigest()
        if events
        else None,
        "updated_at": now_ms(),
        "volume_kind": "shares"
        if kind in {"EQUITY", "ETF"}
        else "contracts"
        if kind == "FUTURE"
        else "unavailable",
        "volume_unit": "股" if kind in {"EQUITY", "ETF"} else "合约" if kind == "FUTURE" else None,
    }


def metadata(symbol, *, deadline=None):
    deadline = deadline or time.monotonic() + settings.provider_request_seconds
    with _operation(deadline, stage="metadata") as session:
        info = yf.Ticker(symbol, session=session).info
        if not info or not info.get("symbol"):
            raise YahooError("metadata_unavailable", "Yahoo 元数据暂不可用")
        return _metadata(info)


def search_metadata(query, *, deadline=None):
    if not query.strip():
        return []
    deadline = deadline or time.monotonic() + settings.provider_request_seconds
    with _operation(deadline) as session:
        rows = yf.Search(
            query,
            max_results=20,
            news_count=0,
            lists_count=0,
            include_cb=False,
            include_nav_links=False,
            session=session,
            timeout=max(0.01, deadline - time.monotonic()),
        ).quotes
        return [dict(row) for row in rows[:20] if allowed(row)]


def _history(ticker, meta, frame, start, end, deadline):
    return ticker.history(
        start=int(start / 1000),
        end=int((end + 999) / 1000),
        interval=YAHOO_INTERVALS[frame],
        auto_adjust=meta["adjustment"] == "auto",
        back_adjust=False,
        repair=False,
        actions=True,
        prepost=False,
        rounding=False,
        timeout=max(0.01, deadline - time.monotonic()),
    )


def _rows(meta, frame, data, before):
    result = []
    high_period = frame in {"D1", "W1", "MN"}
    for index, row in data.iterrows():
        stamp = pd.Timestamp(index)
        if stamp.tzinfo is None:
            raise YahooError("invalid_data", "Yahoo 历史缺少交易所时区")
        start = int(stamp.timestamp() * 1000)
        # The exchange DATE is the chart label, not the UTC date of its anchor.
        label = (
            int(datetime.combine(stamp.date(), datetime.min.time(), UTC).timestamp() * 1000)
            if high_period
            else start
        )

        price_columns = ("Open", "High", "Low", "Close")
        prices = [DecimalString(row[name]) for name in price_columns]
        if any(v is None for v in prices):
            # actions=True can add a pure corporate-action row without a price
            # observation. It is neither a candle nor evidence of completion.
            volume = row.get("Volume")
            actions = [DecimalString(row.get(name))
                       for name in ("Dividends", "Stock Splits", "Capital Gains")]
            if (all(pd.isna(row[name]) for name in price_columns)
                    and (pd.isna(volume) or volume == 0)
                    and any(value is not None and float(value) != 0 for value in actions)):
                continue
            raise YahooError("invalid_data", "Yahoo OHLC 缺失或不是有限数值")
        o, h, low, c = map(float, prices)
        if h < max(o, c, low) or low > min(o, c, h):
            raise YahooError("invalid_data", "Yahoo OHLC 高低关系无效")
        offset = {
            "D1": pd.DateOffset(days=1),
            "W1": pd.DateOffset(weeks=1),
            "MN": pd.DateOffset(months=1),
        }.get(frame)
        end = (
            int((stamp + offset).timestamp() * 1000)
            if offset
            else start + {"M1": 60000, "M5": 300000, "M15": 900000, "H1": 3600000}[frame]
        )
        value = row.get("Volume")
        # SDK missing Volume becomes 0: no positive evidence => unavailable.
        volume = (
            DecimalString(value)
            if meta.get("volume_kind") != "unavailable" and value is not None and value > 0
            else None
        )
        result.append(
            {
                "start": start,
                "end": end,
                "chart_time": label,
                "open": prices[0],
                "high": prices[1],
                "low": prices[2],
                "close": prices[3],
                "complete": False,
                "volume": volume,
                "volume_complete": False,
            }
        )
    # Successor source bars prove that the previous source interval has ended.
    for bar in result[:-1]:
        bar["complete"] = True
        bar["volume_complete"] = bar["volume"] is not None
    return [bar for bar in result if bar["chart_time"] < before]


def DecimalString(value):
    from decimal import Decimal, InvalidOperation

    try:
        number = Decimal(str(value))
        return format(number, "f") if number.is_finite() else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def archive_page(identity, start, end):
    """Fixed managed inputs over the existing yfinance operation/parser path.

    No platform cache is read or mutated. Explicit adjustment comes from the
    immutable acquisition identity; platform auto-adjust defaults stay intact.
    """
    from .history_mode_artifacts import date_bounds
    from .market_contracts import NativeBarRow, NativeCandleBatch, RequestResult, SourceIdentity

    identity = SourceIdentity.model_validate(identity)
    values, frame = identity.parameters, identity.parameters["timeframe"]
    if frame not in YAHOO_INTERVALS or values["adjustment"] not in ("none", "supplier"):
        raise ValueError("Yahoo 固定归档不支持此周期或价格口径")
    if values["endpoint"] != "yfinance.Ticker.history" or values["rules"] != "yfinance-archive-v1":
        raise ValueError("Yahoo 固定归档来源规则不匹配")
    deadline = time.monotonic() + settings.provider_request_seconds
    retention, span = history_policy(frame)
    observed = now_ms()
    request_start = max(start, observed - retention * 86400000) if retention else start
    if span:
        request_start = max(request_start, end - span * 86400000)
    if request_start >= end:
        return NativeCandleBatch(identity=identity, timeframe=frame, window_start=start,
            window_end=end, checkpoint=end, observed_at=observed, rows=(),
            result=RequestResult(status="empty_success"),
            volume_kind=values["volume_kind"], volume_unit=values["volume_unit"])
    meta = {"symbol": identity.provider_symbol, "timezone": values["timezone"],
            "adjustment": "supplier", "volume_kind": values["volume_kind"]}
    with _operation(deadline, stage="managed_archive") as session:
        data = _history(yf.Ticker(meta["symbol"], session=session), meta, frame,
                        request_start, end, deadline)
        if "Volume" in data and any(pd.notna(value) and value < 0 for value in data["Volume"]):
            raise ValueError("Yahoo 归档成交量不能为负数")
        parsed = _rows(meta, frame, data, end)
    output = []
    for value in parsed:
        label = datetime.fromtimestamp(value["start"] / 1000, UTC).astimezone(
            ZoneInfo(values["timezone"]))
        high = frame in ("D1", "W1", "MN")
        left, right = date_bounds(label.date(), frame) if high else (value["start"], value["end"])
        complete = value["complete"] or right <= min(end, observed)
        if frame == "D1" and values["session"].startswith("0930-1600"):
            right = int(label.replace(hour=16, minute=0).timestamp() * 1000)
            complete = right <= min(end, observed)
        if not start <= left < end:
            continue
        complete = complete and right <= min(end, observed)
        output.append(NativeBarRow(timeframe=frame, start=left, end=right,
            **{key: value[key] for key in ("open", "high", "low", "close", "volume")},
            source_label=label.isoformat(), trading_date=label.date().isoformat() if high else None,
            complete=complete, confirmation="session_elapsed" if complete else "unconfirmed"))
    return NativeCandleBatch(identity=identity, timeframe=frame, window_start=start,
        window_end=end, checkpoint=end, observed_at=observed, rows=tuple(output),
        result=RequestResult(status="data" if output else "empty_success"),
        volume_kind=values["volume_kind"], volume_unit=values["volume_unit"])


def native_page(meta, frame, before, count, *, deadline=None, optional=0):
    if frame not in YAHOO_INTERVALS or not 1 <= count <= 4000:
        raise ValueError("无效 Yahoo 原生周期或根数")
    deadline = deadline or time.monotonic() + settings.provider_request_seconds
    retention, span = history_policy(frame)
    now = now_ms()
    floor = (
        max(1, now - retention * 86400000) if retention else max(1, meta.get("first_trade_ms") or 1)
    )
    high = frame in {"D1", "W1", "MN"}
    end = min(now + 1, before + (2 * 86400000 if high else 0))
    if not retention and end <= floor:
        # Validate a listing boundary with a successful source window near the
        # known first trade, while keeping the original exclusive chart bound.
        end = min(now + 1, floor + 30 * 86400000)
    # Natural durations estimate requests; returned bars, not estimates, prove coverage.
    duration = {
        "M1": 60000,
        "M5": 300000,
        "M15": 900000,
        "H1": 3600000,
        "D1": 86400000,
        "W1": 604800000,
        "MN": 2678400000,
    }[frame]
    estimate = max(
        3 * 86400000 if retention else 30 * 86400000, (count + optional + 3) * duration * 3
    )
    if span:
        estimate = min(estimate, span * 86400000)
    rows, covered, evidence, boundary = [], [], None, False
    with _operation(deadline) as session:
        ticker = yf.Ticker(meta["symbol"], session=session)
        for _ in range(4):
            from .market_resources import LANE
            from .provider_cache import check_cancelled, interactive_busy

            check_cancelled()
            if rows and LANE.get() == "history" and interactive_busy("yahoo"):
                break
            start = max(floor, end - estimate)
            if end <= floor:
                evidence = {
                    "kind": "rolling_window",
                    "left": floor,
                    "confirmed_at": now,
                    "retry_at": now + settings.yahoo_poll_seconds * 1000,
                    "policy_days": retention,
                }
                break
            successful_empty = False
            try:
                data = _history(ticker, meta, frame, start, end, deadline)
            except YFPricesMissingError as error:
                response = getattr(session, "chart_response", None)
                chart = response[1].get("chart", {}) if response and response[0] == 200 else {}
                results = chart.get("result") or []
                successful_empty = bool(
                    not chart.get("error") and results and not results[0].get("timestamp")
                )
                if successful_empty:
                    data = pd.DataFrame()
                else:
                    # The SDK's no-data exception alone does not prove an empty
                    # successful window. Fail without writing coverage.
                    text = str(error).lower()
                    if retention and (
                        "must be within" in text
                        or "requested range" in text
                        or "last 30 days" in text
                    ):
                        evidence = {
                            "kind": "rolling_window",
                            "left": max(floor, end),
                            "confirmed_at": now,
                            "retry_at": now + settings.yahoo_poll_seconds * 1000,
                            "reason": "upstream_window_rejected",
                            "policy_days": retention,
                        }
                        break
                    raise YahooError(
                        "no_data_unconfirmed", "Yahoo 本次无周期数据，尚未确认历史边界"
                    ) from None
            batch = _rows(meta, frame, data, before)
            rows = sorted({b["start"]: b for b in batch + rows}.values(), key=lambda b: b["start"])
            # Date-labelled high periods are exclusive at the chart's right edge.
            covered_start = (
                int(
                    datetime.combine(
                        instant(start).astimezone(data.index.tz).date(), datetime.min.time(), UTC
                    ).timestamp()
                    * 1000
                )
                if high and not data.empty
                else start
            )
            covered.append([max(0, covered_start), before if not rows or end >= before else end])
            source_meta = ticker._price_history._history_metadata or {}
            if data.empty and successful_empty:
                source_meta = results[0].get("meta") or source_meta
            first = source_meta.get("firstTradeDate")
            lifecycle_floor = (
                int(first.timestamp() * 1000)
                if isinstance(first, (datetime, pd.Timestamp))
                else int(first * 1000)
                if first is not None
                else meta.get("first_trade_ms")
            )
            if not retention and lifecycle_floor is not None and start <= lifecycle_floor:
                boundary = True
                evidence = {
                    "kind": "lifecycle",
                    "first_trade_ms": lifecycle_floor,
                    "confirmed_at": now,
                }
                covered = [[0, before]]
                break
            if len(rows) >= count:
                break
            if start <= floor:
                if retention:
                    evidence = {
                        "kind": "rolling_window",
                        "left": floor,
                        "confirmed_at": now,
                        "retry_at": now + settings.yahoo_poll_seconds * 1000,
                        "policy_days": retention,
                    }
                break
            end = start
            if time.monotonic() >= deadline:
                raise TimeoutError("Yahoo 请求超过时间预算")
    # Save all valid rows in the bounded SDK result: trimming can falsely cover
    # a queried range whose earlier returned prices were discarded.
    coverage = [[min(a for a, b in covered), before]] if covered else []
    return {
        "bars": rows,
        "has_more": not boundary,
        "history_boundary": boundary,
        "coverage": coverage,
        "boundary_evidence": evidence,
        "availability": "window_limit"
        if evidence and evidence["kind"] == "rolling_window"
        else "available",
        "series_kind": "provider",
        "basis": meta["basis"],
        "calendar": meta["calendar"],
        "precision": meta["precision"],
        "indicators": [],
        "as_of": now_ms(),
        **{
            k: meta.get(k)
            for k in (
                "volume_kind",
                "volume_unit",
                "source",
                "symbol",
                "adjustment",
                "price_description",
            )
        },
    }


def quote(meta, *, deadline=None):
    deadline = deadline or time.monotonic() + settings.provider_request_seconds
    with _operation(deadline) as session:
        info = yf.Ticker(meta["symbol"], session=session).info
        price = DecimalString(info.get("regularMarketPrice"))
        if price is None:
            raise YahooError("quote_unavailable", "Yahoo 市场报价暂不可用")
        details = _metadata(info)
        stamp = info.get("regularMarketTime")
        return {
            "price": price,
            "previous_close": DecimalString(info.get("regularMarketPreviousClose")),
            "quote_time": stamp * 1000 if stamp is not None else None,
            "fetched_at": now_ms(),
            "delay_seconds": details["delay_seconds"],
            "reported_delay_seconds": details["reported_delay_seconds"],
            "declared_delay_seconds": details["declared_delay_seconds"],
            "status": "ok",
            "basis": "Yahoo 市场报价",
        }
