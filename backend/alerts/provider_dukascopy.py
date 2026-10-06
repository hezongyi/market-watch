"""Dukascopy JSON3 native periods through pinned SDK request construction.

No M1 resampling. Original OHLC/volume and UTC labels are retained. JSON3 does
not supply a confirmation bit: elapsed interval is disclosed separately.
"""

import hashlib
import json
import re
import time
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from types import SimpleNamespace

from fastapi import HTTPException

from .chart_data import FRAMES
from .dukascopy_history import DukascopyHistory
from .market_resources import cooldown, request_slot
from .storage import instant, ms, now_ms
from .volume import encoded

INTERVALS = dict(zip(FRAMES, ("1MIN", "5MIN", "15MIN", "30MIN", "1HOUR", "4HOUR", "1DAY", "1WEEK", "1MONTH")))
WIDTHS = dict(zip(FRAMES[:-1], (60000, 300000, 900000, 1800000, 3600000, 14400000, 86400000, 604800000)))
CALENDAR = "dukascopy_native_utc"


def stable_id(symbol):
    return "DUKA:" + hashlib.sha256(symbol.encode()).hexdigest()[:32]


@lru_cache(maxsize=1)
def _catalog():
    from dukascopy_python import instruments

    from .history_catalog import asset_class

    rows = {}
    for name, symbol in vars(instruments).items():
        if not name.startswith("INSTRUMENT_") or not isinstance(symbol, str):
            continue
        logical = re.sub(r"[^A-Z0-9]", "", symbol.upper())
        kind = asset_class(name, symbol)
        rows[symbol] = {"id": stable_id(symbol), "symbol": symbol, "label": symbol,
            "logical_symbol": logical, "source": "dukascopy", "asset_type": {
                "forex": "CURRENCY", "metal": "METAL", "crypto": "CRYPTO", "index": "INDEX"}.get(kind, "OTHER"),
            "asset_class": kind, "available": True, "supported": True, "series_kinds": ["provider"],
            "precision": 8, "precision_status": "display_only; source_prices_not_rounded",
            "frames": list(FRAMES), "description": "平台 · Dukascopy · Bid · 原生周期",
            "metadata_origin": "dukascopy-python 4.0.1 instruments; coverage_not_verified"}
    return sorted(rows.values(), key=lambda row: row["symbol"])


def catalog(query=""):
    term = query.strip().casefold()
    return [dict(row) for row in _catalog() if term in
            (row["symbol"] + row["logical_symbol"]).casefold()]


class NativeDataError(ValueError):
    """Invalid supplier payload, distinguishable from caller validation."""
    status = "invalid_data"


class NativeRateLimited(NativeDataError):
    status = "rate_limited"


def metadata(ident):
    row = next((row for row in catalog() if row["id"] == ident), None)
    if row is None:
        raise HTTPException(404, "未知Dukascopy来源品种，请重新搜索")
    return {**row, "name": row["label"], "basis": "bid", "series_kind": "provider",
        "calendar": CALENDAR, "timezone": "Etc/UTC", "session": "24x7",
        "session_verified": False, "volume_kind": "quantity", "volume_unit": "source_quantity",
        "price_description": "Bid · 来源原生UTC周期", "native_page_capacity": 4000,
        "request_parameters": {"offer_side": "B", "splits": "true", "stocks": "true"},
        "completion_basis": "elapsed_native_interval; confirmation_not_supplied"}


def interval_end(start, frame):
    if frame != "MN":
        return start + WIDTHS[frame]
    moment = instant(start)
    return ms(moment.replace(year=moment.year + (moment.month == 12), month=moment.month % 12 + 1))


def native_page(meta, frame, before, count, *, client=None, deadline=None, optional=0):
    if frame not in INTERVALS or not 1 <= count <= 4000 or optional < 0:
        raise ValueError("无效Dukascopy原生周期或根数")
    try:
        return _native_page(meta, frame, before, count, client=client, deadline=deadline, optional=optional)
    except NativeDataError:
        raise
    except (ValueError, InvalidOperation, TypeError, IndexError) as error:
        raise NativeDataError("Dukascopy返回数据无效；未确认历史边界") from error


def _native_page(meta, frame, before, count, *, client=None, deadline=None, optional=0):
    from .provider_cache import check_cancelled
    from .provider_chart import record_timing
    from .provider_transport import activity, pooled_client

    deadline = deadline or time.monotonic() + 20
    client = client or pooled_client("dukascopy")
    adapter = DukascopyHistory(client=client)
    # Native SDK decoding can preserve arbitrary JSON decimals, just like M1.
    adapter.sdk.json = SimpleNamespace(loads=lambda raw: json.loads(raw, parse_float=Decimal))
    requested = min(4000, count + optional)

    def get(url, **kwargs):
        check_cancelled()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Dukascopy原生请求超过时间预算")
        kwargs["params"] = {**kwargs["params"], "time_direction": "P"}
        started = time.monotonic()
        with request_slot("dukascopy", deadline=deadline, cancelled=lambda: time.monotonic() >= deadline):
            with activity(client) as transport:
                response = transport.get(url, **kwargs, timeout=max(.001, min(7, deadline - time.monotonic())))
        record_timing("dukascopy_native_http", started)
        if response.status_code == 429:
            value = response.headers.get("Retry-After", "")
            cooldown("dukascopy", retry_seconds=int(value) if value.isdigit() else None)
        response.raise_for_status()
        callback = kwargs["params"]["jsonp"]
        if not response.text.startswith(callback + "(") or not response.text.endswith(");"):
            raise ValueError("Invalid Dukascopy native JSONP")
        return response

    adapter.sdk.requests = SimpleNamespace(get=get)
    # Count-to exclusive cursor is translated to the source's last_update.
    raw = adapter.sdk._fetch(meta["symbol"], INTERVALS[frame], "B", before - 1, limit=requested)
    check_cancelled()
    if time.monotonic() >= deadline:
        raise TimeoutError("Dukascopy原生请求超过时间预算")
    if isinstance(raw, dict) and isinstance(raw.get("error"), str) and (
            "too many requests" in raw["error"].casefold() or "bot blocked" in raw["error"].casefold()):
        cooldown("dukascopy")
        raise NativeRateLimited("Dukascopy来源限流，已进入共享冷却；缓存历史保留")
    # JSON3 can over-return its requested limit (observed H4 143 -> 148).
    # Validate the bounded source page, then retain the newest requested rows.
    if not isinstance(raw, list) or len(raw) > 8000:
        raise ValueError(f"Invalid Dukascopy native page type={type(raw).__name__} size={len(raw) if isinstance(raw, (list, dict)) else None} requested={requested}")
    rows, previous = [], before
    observed = now_ms()
    for row in raw:
        if not isinstance(row, list) or len(row) != 6 or type(row[0]) is not int or not 0 <= row[0] < previous:
            raise ValueError("Dukascopy native page must be strictly descending and exclusive")
        start = row[0]
        if start > observed:
            raise ValueError("Dukascopy native bar starts in the future")
        prices = {key: str(value) for key, value in zip(("open", "high", "low", "close"), row[1:5])}
        values = [Decimal(value) for value in prices.values()]
        if any(not value.is_finite() or value <= 0 for value in values) or not values[2] <= min(values[0], values[3]) <= max(values[0], values[3]) <= values[1]:
            raise ValueError("Invalid Dukascopy native OHLC")
        stop = interval_end(start, frame)
        closed = stop <= observed
        volume = encoded(row[5])
        rows.append({"start": start, "end": stop, "chart_time": start, **prices,
            "volume": volume, "complete": closed, "volume_complete": closed and volume is not None,
            "time_closed": closed, "source_confirmed": None,
            "completion_basis": "elapsed_native_interval; confirmation_not_supplied"})
        previous = start
    rows.reverse()
    rows = rows[-requested:]
    # A short/empty response is not evidence of inception or of market closure.
    return {"bars": rows, "has_more": True, "history_boundary": False,
        "coverage": [[rows[0]["start"], before]] if rows else [], "boundary_evidence": None,
        "series_kind": "provider", "basis": "bid", "calendar": CALENDAR,
        "precision": meta["precision"], "indicators": [], "as_of": observed,
        "volume_kind": "quantity", "volume_unit": "source_quantity",
        "source": "dukascopy", "symbol": meta["symbol"],
        "completion_basis": meta["completion_basis"],
        "request_evidence": {"interval": INTERVALS[frame], "requested": requested, "returned": len(raw),
            "retained": len(rows),
            "time_direction": "P", "offer_side": "B", "splits": "true", "stocks": "true"}}
