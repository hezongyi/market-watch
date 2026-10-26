"""On-demand AKShare snapshots with a killable deadline and common source slot."""

import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from .config import settings
from .history_mode_artifacts import date_bounds
from .market_contracts import (
    DatasetIdentity,
    MarketRequestError,
    NativeBarRow,
    NativeCandleBatch,
    RequestResult,
    SourceIdentity,
)
from .storage import now_ms

LEGACY_RULES = "akshare-1.19.3-source-label-v1"
RULES = "akshare-1.19.3-source-label-hk-precision-v2"
MINUTES = {"M1": "1", "M5": "5", "M15": "15", "M30": "30", "H1": "60"}
PERIODS = {"D1": "daily", "W1": "weekly", "MN": "monthly"}
EXCHANGES = {"SSE", "SZSE", "BSE", "HKEX", "SHFE", "DCE", "CZCE", "CFFEX", "INE", "GFEX"}


class AKShareRequestError(MarketRequestError):
    def __init__(self, result, error_type):
        super().__init__(result)
        self.error_type = error_type if re.fullmatch(r"[A-Za-z0-9_]{1,80}", error_type) else "Unknown"


def symbol_rules(symbol, source_family=None):
    exchange, _, code = symbol.partition(":")
    if exchange not in EXCHANGES:
        raise ValueError("AKShare 品种需要明确交易所")
    if exchange == "HKEX":
        valid = re.fullmatch(r"\d{5}", code)
        family, timezone, unit, close = "sina-hk", "Asia/Hong_Kong", "shares", 16 * 60 + 10
    elif exchange in ("SSE", "SZSE", "BSE"):
        valid = re.fullmatch(r"\d{6}", code)
        family, timezone, unit, close = "eastmoney-a", "Asia/Shanghai", "lots", 15 * 60 + 10
        if source_family in ("sina-a", "tencent-a"):
            if exchange == "BSE":
                raise ValueError("新浪/腾讯 A 股接口当前仅接入沪深市场")
            family = source_family
            unit = "shares" if family == "sina-a" else "lots"
    else:
        valid = re.fullmatch(r"[A-Z]{1,3}\d{1,4}", code)
        family, timezone, unit, close = "sina-futures", "Asia/Shanghai", "contracts", 15 * 60 + 30
    if not valid:
        raise ValueError("AKShare 品种代码不符合交易所格式")
    return {"exchange": exchange, "code": code, "source_family": family,
        "timezone": timezone, "volume_unit": unit, "close_minute": close,
        "trading_date_rule": "supplier-trading-date-v1", "session": family + "-regular"}


def endpoint(symbol, frame, adjustment="none", source_family=None):
    info = symbol_rules(symbol, source_family)
    daily = frame in PERIODS
    if adjustment not in ("none", "qfq", "hfq"):
        raise ValueError("AKShare 不支持此复权口径")
    if frame not in (*MINUTES, *PERIODS):
        raise ValueError("来源没有此原生周期接口")
    if info["source_family"] == "sina-hk":
        if frame != "D1":
            raise ValueError("已验证的新浪港股接口只提供 D1；周月线请选择 D1 基础派生")
        return "stock_hk_daily"
    if info["source_family"] == "sina-futures":
        if adjustment != "none" or daily and frame != "D1":
            raise ValueError("期货原生接口只提供 D1 和已接入的小周期，不提供原生周月线")
        return "futures_zh_daily_sina" if daily else "futures_zh_minute_sina"
    if info["source_family"] == "sina-a":
        if frame != "D1":
            raise ValueError("新浪 A 股接口只提供 D1")
        return "stock_zh_a_daily"
    if info["source_family"] == "tencent-a":
        if frame != "D1":
            raise ValueError("腾讯 A 股接口只提供 D1")
        return "stock_zh_a_hist_tx"
    if frame == "M1" and adjustment != "none":
        raise ValueError("M1 接口不支持复权")
    prefix = "stock_hk_hist" if info["exchange"] == "HKEX" else "stock_zh_a_hist"
    return prefix if daily else prefix + "_min_em"


def collection_identity(parent, frame):
    parent = DatasetIdentity.model_validate(parent)
    info = symbol_rules(parent.provider_symbol, parent.source_family)
    name = endpoint(parent.provider_symbol, frame, parent.adjustment, parent.source_family)
    if parent.source_family != info["source_family"] or parent.trading_date_rule != info["trading_date_rule"]:
        raise ValueError("AKShare 已固定的来源或交易日规则不匹配")
    return SourceIdentity(**{key: getattr(parent, key) for key in (
        "source", "channel", "environment", "account_scope", "provider_symbol", "basis")},
        parameters={"timeframe": frame, "endpoint": name, "adjustment": parent.adjustment,
            "source_family": parent.source_family, "trading_date_rule": parent.trading_date_rule,
            "session": info["session"], "timezone": info["timezone"], "rules": RULES})


def invoke(endpoint_name, parameters, *, deadline=None):
    if not settings.akshare_enabled:
        raise ValueError("AKShare 行情源未启用")
    from .market_resources import LANE, lane, request_slot

    deadline = deadline or time.monotonic() + 30
    with lane(LANE.get() or "chart"), request_slot("akshare", deadline=deadline):
        if time.monotonic() >= deadline:
            raise TimeoutError("AKShare 请求超时")
        env = dict(os.environ)
        if settings.market_proxy:
            env.update(HTTP_PROXY=settings.market_proxy, HTTPS_PROXY=settings.market_proxy)
        process = subprocess.Popen([sys.executable, "-m", "alerts.akshare_worker"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, env=env, start_new_session=True)
        try:
            output, _ = process.communicate(json.dumps({"endpoint": endpoint_name,
                "parameters": parameters}), timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=0.5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise TimeoutError("AKShare 请求超时，子进程已回收") from None
        if process.returncode or len(output) > 64 * 1024 * 1024:
            raise MarketRequestError(RequestResult(status="unavailable"))
        try:
            payload = json.loads(output)
            result = RequestResult(status=payload["status"])
            records = payload["records"]
            if not isinstance(records, list) or len(records) > 100000:
                raise ValueError("Invalid protocol")
        except (ValueError, KeyError, TypeError):
            raise MarketRequestError(RequestResult(status="invalid_payload")) from None
        if not result.successful:
            raise AKShareRequestError(result, payload.get("error_type", "Unknown"))
        return records


def request_parameters(source, start, end):
    frame, info = source.parameters["timeframe"], symbol_rules(
        source.provider_symbol, source.parameters["source_family"])
    values = {"symbol": info["code"]}
    if info["source_family"] in ("sina-hk", "sina-a"):
        values["adjust"] = "" if source.parameters["adjustment"] == "none" else source.parameters["adjustment"]
        if info["source_family"] == "sina-a":
            values["symbol"] = ("sh" if info["exchange"] == "SSE" else "sz") + info["code"]
        return values
    if info["source_family"] == "tencent-a":
        zone = ZoneInfo(info["timezone"])
        left = datetime.fromtimestamp(start / 1000, UTC).astimezone(zone)
        right = datetime.fromtimestamp(end / 1000, UTC).astimezone(zone)
        values.update(symbol=("sh" if info["exchange"] == "SSE" else "sz") + info["code"],
            adjust="" if source.parameters["adjustment"] == "none" else source.parameters["adjustment"],
            start_date=left.strftime("%Y%m%d"), end_date=right.strftime("%Y%m%d"))
        return values
    if info["source_family"] == "sina-futures":
        if frame in MINUTES:
            values["period"] = MINUTES[frame]
        return values  # One snapshot; never call this once per historical month.
    zone = ZoneInfo(info["timezone"])
    left = datetime.fromtimestamp(start / 1000, UTC).astimezone(zone)
    right = datetime.fromtimestamp(end / 1000, UTC).astimezone(zone)
    values.update(period=PERIODS.get(frame, MINUTES.get(frame)),
        adjust="" if source.parameters["adjustment"] == "none" else source.parameters["adjustment"],
        start_date=left.strftime("%Y%m%d" if frame in PERIODS else "%Y-%m-%d %H:%M:%S"),
        end_date=right.strftime("%Y%m%d" if frame in PERIODS else "%Y-%m-%d %H:%M:%S"))
    return values


def parse_records(source, records, *, start, end, observed_at):
    frame, info = source.parameters["timeframe"], symbol_rules(
        source.provider_symbol, source.parameters["source_family"])
    zone = ZoneInfo(info["timezone"])
    normalized = []
    for record in records:
        label = record.get("日期") or record.get("时间") or record.get("date") or record.get("datetime")
        if not label:
            raise ValueError("AKShare 缺少来源时间标签")
        local = datetime.fromisoformat(label[:19]).replace(tzinfo=zone)
        if frame in PERIODS:
            trading_date = local.date().isoformat()
            left, right = date_bounds(trading_date, frame)
            if frame == "D1":
                close = local.replace(hour=info["close_minute"] // 60,
                                      minute=info["close_minute"] % 60)
                right = int(close.timestamp() * 1000)
            # Source weekly/monthly labels can denote the last observed trading
            # day. Normalize to its period while preserving the original date.
        else:
            period = int(MINUTES[frame]) * 60000
            # Verified EastMoney and Sina minute samples are close-labelled.
            right = int(local.timestamp() * 1000)
            left = right - period
            trading_date = None  # Never infer Chinese futures trading days from night timestamps.
        if not start <= left < end:
            continue
        names = {"open": "开盘", "high": "最高", "low": "最低", "close": "收盘", "volume": "成交量"}
        values = {key: record.get(key) if key in record else record.get(name) for key, name in names.items()}
        for key in ("open", "high", "low", "close"):
            if values[key] is None:
                raise ValueError("AKShare OHLC 缺失")
            values[key] = str(Decimal(values[key]))
        evidence = {}
        if info["source_family"] == "sina-hk" and source.parameters["rules"] == RULES:
            # Sina's HK decoder emits occasional 0.00001 dust beyond an OHLC
            # extreme. Canonicalize only that verified precision defect, keep
            # the exact SDK values alongside it, and reject larger anomalies.
            prices = {key: Decimal(values[key]) for key in ("open", "high", "low", "close")}
            upper, lower = max(prices["open"], prices["close"]), min(prices["open"], prices["close"])
            if prices["high"] < upper or prices["low"] > lower:
                rounded = {key: price.quantize(Decimal("0.0001")) for key, price in prices.items()}
                dust = max(upper - prices["high"], prices["low"] - lower)
                if dust <= Decimal("0.00001") and rounded["high"] >= max(rounded["open"], rounded["close"]) and rounded["low"] <= min(rounded["open"], rounded["close"]):
                    evidence = {"source_ohlc": {key: values[key] for key in prices},
                                "price_normalization": "sina-hk-decoder-dust-4dp-v1"}
                    values.update({key: format(price, "f") for key, price in rounded.items()})
        values["volume"] = str(Decimal(values["volume"])) if values["volume"] is not None else None
        normalized.append({"timeframe": frame, "start": left, "end": right, **values, **evidence,
            "source_label": label, "trading_date": trading_date, "complete": False,
            "confirmation": "unconfirmed"})
    normalized.sort(key=lambda row: row["start"])
    for index, row in enumerate(normalized):
        successor = index + 1 < len(normalized)
        if frame in PERIODS:
            closed = row["end"] <= min(end, observed_at)
            observed_local = datetime.fromtimestamp(observed_at / 1000, UTC).astimezone(zone)
            # A subsequent-day refresh also confirms a futures trading-day bar;
            # night-session timestamps never assign that day here.
            confirmed = successor or (closed and (info["source_family"] != "sina-futures"
                                      or datetime.fromisoformat(row["trading_date"]).date() < observed_local.date()))
        else:
            confirmed = successor
        row["complete"] = confirmed and row["end"] <= min(end, observed_at)
        row["confirmation"] = "next_bar" if row["complete"] and successor else "session_elapsed" if row["complete"] else "unconfirmed"
    return tuple(NativeBarRow.model_validate(row) for row in normalized)


def parse_sina_factors(records, rows):
    """Attach the effective event factor to raw daily rows without changing OHLC."""
    events = {}
    for record in records:
        label = record.get("date") or record.get("日期")
        value = record.get("qfq_factor")
        if not label or value is None:
            raise ValueError("新浪前复权因子字段缺失")
        day = str(label)[:10]
        datetime.strptime(day, "%Y-%m-%d")
        try:
            factor = Decimal(str(value))
        except InvalidOperation:
            raise ValueError("新浪前复权因子不是数值") from None
        if not factor.is_finite() or factor <= 0 or day in events and events[day] != factor:
            raise ValueError("新浪前复权因子无效或日期冲突")
        events[day] = factor
    events = sorted(events.items())
    if not events:
        raise ValueError("新浪未返回有效前复权因子")
    output = []
    for row in rows:
        day = row.trading_date
        applicable = [factor for event_day, factor in events if event_day <= day]
        if not applicable:
            raise ValueError("新浪前复权因子未覆盖行情日期")
        value = format(applicable[-1], "f")
        output.append(row.model_copy(update={"adjustment_basis": {
            "kind": "sina_qfq_factor", "value": value, "effective_date": max(
                event_day for event_day, factor in events if event_day <= day),
            "rule": "sina-factor-forward-v1"}}))
    return tuple(output)


class AKShareHistory:
    def native_page(self, identity, start, end, *, deadline=None):
        identity = SourceIdentity.model_validate(identity)
        frame = identity.parameters["timeframe"]
        expected = endpoint(identity.provider_symbol, frame, identity.parameters["adjustment"],
                            identity.parameters["source_family"])
        if identity.parameters["endpoint"] != expected or identity.parameters["rules"] not in (LEGACY_RULES, RULES):
            raise ValueError("AKShare endpoint rules differ from the fixed acquisition identity")
        records = invoke(expected, request_parameters(identity, start, end), deadline=deadline)
        observed = now_ms()
        rows = parse_records(identity, records, start=start, end=end, observed_at=observed)
        if frame == "D1" and identity.parameters["adjustment"] == "none" and identity.parameters["source_family"] in ("sina-a", "sina-hk"):
            info = symbol_rules(identity.provider_symbol, identity.parameters["source_family"])
            factor_endpoint = "stock_zh_a_daily" if info["source_family"] == "sina-a" else "stock_hk_daily"
            factor_symbol = (("sh" if info["exchange"] == "SSE" else "sz") + info["code"]
                             if info["source_family"] == "sina-a" else info["code"])
            try:
                factors = invoke(factor_endpoint, {"symbol": factor_symbol, "adjust": "qfq-factor"}, deadline=deadline)
                rows = parse_sina_factors(factors, rows)
            except (MarketRequestError, ValueError, TimeoutError):
                # Preserve valid raw observations. The qfq artifact refuses
                # rows without a valid basis, with a visible unavailable state.
                pass
        info = symbol_rules(identity.provider_symbol, identity.parameters["source_family"])
        return NativeCandleBatch(identity=identity, timeframe=frame, window_start=start,
            window_end=end, checkpoint=end, observed_at=observed,
            rows=rows, result=RequestResult(status="data" if rows else "empty_success"),
            volume_kind="quantity", volume_unit=info["volume_unit"])

    def close(self):
        pass


def platform_page(meta, frame, before, count, *, deadline=None):
    """Selected native frame only, sharing fixed-source content and source slots."""
    from .history_mode_sources import dataset_identity
    from .source_history_store import shared_native_page

    if frame not in meta.get("frames", []) or not 1 <= count <= 4000:
        raise ValueError("此品种尚未验证所选原生周期")
    parent = dataset_identity("akshare", meta["symbol"], "native_periods", "none")
    source = collection_identity(parent, frame)
    if meta["source_family"] == "tencent-a":
        parameters = {**source.parameters, "source_family": "tencent-a",
            "endpoint": endpoint(meta["symbol"], frame, "qfq", "tencent-a"),
            "adjustment": "qfq", "session": "tencent-a-regular"}
        source = source.model_copy(update={"parameters": parameters})
    if meta["source_family"] in ("sina-a", "sina-hk"):
        parameters = {**source.parameters, "adjustment": "qfq",
            "endpoint": endpoint(meta["symbol"], frame, "qfq", source.parameters["source_family"])}
        source = source.model_copy(update={"parameters": parameters})
    observed = now_ms()
    right = min(before, observed)
    if frame in PERIODS:
        left = max(0, right - max(count * (3 if frame == "D1" else 10 if frame == "W1" else 35), 90) * 86400000)
    else:
        left = max(0, right - max(count * int(MINUTES[frame]) * 60000 * 5, 90 * 86400000))
    left, right = left // 60000 * 60000, right // 60000 * 60000

    class Request:
        def native_page(self, identity, start, end):
            return AKShareHistory().native_page(identity, start, end, deadline=deadline)

    batch = shared_native_page(Request(), source, left, right,
        fresh_after=observed - 60000, volume_kind="quantity", volume_unit=meta["volume_unit"])
    bars = [{**row.model_dump(), "chart_time": row.start, "volume_complete": row.complete and row.volume is not None}
            for row in batch.rows if row.start < before]
    visible = bars[-count:]
    return {"bars": visible, "has_more": bool(bars), "history_boundary": False,
        "coverage": [[visible[0]["chart_time"], min(before, observed)]] if visible else [],
        "availability": "observed_window", "series_kind": "provider", "basis": "last",
        "calendar": "source_date", "precision": meta["precision"], "indicators": [],
        "volume_kind": "quantity", "volume_unit": meta["volume_unit"], "as_of": batch.observed_at}
