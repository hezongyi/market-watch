"""Quote text over one stored observation; never obtains prices or creates demand."""

from datetime import UTC, datetime

SESSION_LABELS = {"closed": "休市", "scheduled_open": "交易时段内", "unknown": "时段未核实"}


def describe(value):
    """Keep an unformatted base so host timezone changes are idempotent."""
    value = dict(value)
    base = value.setdefault("description_base", value.get("description", ""))
    parts = [base]
    if value.get("time_type") != "fixed_history":
        parts.append(SESSION_LABELS.get(value.get("market_session"), "时段未核实"))
        if value.get("session_reason"):
            parts.append(value["session_reason"])
    if value.get("session_conflict_reason"):
        parts.append(value["session_conflict_reason"])
    if value.get("fetch_status") not in (None, "ok"):
        parts.append("更新失败，保留上次数据" if value.get("lp") is not None else "更新失败，暂无成功行情")
    event = value.get("quote_time")
    at = event if event is not None else value.get("data_start")
    read_at = value.get("read_at")
    stale = isinstance(at, (int, float)) and isinstance(read_at, (int, float)) and read_at - at > 180000
    if value.get("market_session") == "scheduled_open" and (at is None or stale):
        parts.append("等待新行情")
    if at is None:
        parts.append("暂无行情更新时间")
    else:
        prefix = "历史数据时间" if value.get("time_type") == "fixed_history" else "最后更新于" if event is not None else "最后行情时间"
        parts.append(prefix + " " + datetime.fromtimestamp(at / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S UTC"))
        if value.get("time_type") == "source_m1" or value.get("observation_type") == "source_m1":
            end = value.get("data_end")
            interval = "（区间至 " + datetime.fromtimestamp(end / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S UTC") + "，不含终点）" if isinstance(end, (int, float)) else ""
            parts.append("来源 M1 分钟数据" + interval)
    value["description"] = " · ".join(parts)
    return value


def fixed_snapshot(db, ident, metadata):
    from .history_artifacts import chart_page

    frame = metadata["frames"][0]
    page = chart_page(db, ident, frame, count=1)
    last = page["bars"][-1] if page["bars"] else None
    result = {"time_type": "fixed_history", "quote_time": None, "resolution": frame,
              "version_id": ident, "data_start": last["start"] if last else None,
              "data_end": last["end"] if last else None}
    if last:
        result["lp"] = float(last["close"])
    return result
