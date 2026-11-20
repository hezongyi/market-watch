"""Read-only presets over the same fixed series used by the chart.

Presets resolve once into ordinary alert fields. They never create a rule,
collect data or schedule a daily rollover.
"""

from datetime import UTC
from decimal import Decimal
from zoneinfo import ZoneInfo

from pydantic import Field

from .calendar_profile import closures_from
from .chart_alert_domain import Contract
from .composite_chart import chart_page
from .composite_series import period
from .domain import calendar_from, scheduled_open
from .storage import (
    CompositeRevision,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    RealtimeMapping,
    instant,
    now_ms,
)


class PreviousDayQuery(Contract):
    instrument: str = Field(pattern=r"^[a-f0-9]{64}$")
    composite_revision_id: str | None = Field(default=None, max_length=64)


def previous_day(db, body, *, now=None):
    from .live_session import effective_profile
    from .notification_transport import phone_reason
    from .price_alert_evaluator import eligibility
    from .series_access import metadata

    stamp = now_ms() if now is None else now
    composite = db.get(MarketComposite, body.instrument)
    if not composite or composite.permission_scope != "workspace:default":
        raise ValueError("请先打开已开启实时的自建行情")
    revision = db.get(CompositeRevision, body.composite_revision_id or composite.active_revision_id)
    if not revision or revision.composite_id != composite.id:
        raise ValueError("图表来源已改变，请重新打开菜单")
    meta = metadata(db, composite.id, "composite", selected_revision=revision)
    if not {"M5", "D1"}.issubset(meta["frames"]):
        raise ValueError("请先维护 M5 与 D1 周期，再使用前日高低模板")
    eligibility(db, revision, mode="close", now=stamp, lock=False)
    version = db.get(HistoryVersion, revision.history_version_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    profile = effective_profile(target.identity, db.get(Instrument, target.instrument_id).calendar_profile)
    phase = revision.rules["aggregation_calendar"]
    day_start, day_end = period(stamp, "D1", phase)

    def has_session(left, right):
        # Only source-backed closures may skip a missing day. Keep an unknown
        # trading day as missing rather than silently selecting an older candle.
        for at in range(left, right, 60000):
            selected = version.manifest.get("calendar_profile", {}) if at < revision.seam else profile
            if scheduled_open(instant(at), calendar_from(phase, selected, explicit=True),
                              closures=closures_from(selected)):
                return True
        return False

    if not has_session(day_start, day_end):
        raise ValueError("当前日线处于休市日，请在需要监控的交易日创建")
    reference_end = day_start
    for _ in range(32):
        reference_start, reference_end = period(reference_end - 1, "D1", phase)
        if has_session(reference_start, reference_end):
            break
        reference_end = reference_start
    else:
        raise ValueError("近期没有可确认的前一交易日")
    page = chart_page(db, composite.id, "D1", before=day_start, count=1,
                      revision_id=revision.id, now=stamp)
    rows = page["bars"]
    daily = rows[-1] if rows else None
    if (not daily or daily["start"] != reference_start or daily["end"] != reference_end
            or not daily.get("time_closed") or not daily.get("source_confirmed")
            or daily.get("mixed_source")):
        raise ValueError("前一交易日日线尚未确认，请等待数据维护完成后重试")
    if reference_end <= revision.seam:
        if version.start > reference_start or version.end < reference_end:
            raise ValueError("前日历史尚未覆盖整个交易日，请完成历史维护后重试")
    else:
        from .price_alert_close import bars, window_reason
        from .price_alert_confirmation import facts

        reason = window_reason(db, revision, target, page["input_revision"], facts(db, target.identity),
                               reference_start, reference_end,
                               row=next(iter(bars(db, revision, "D1", page["input_revision"],
                                   start=reference_start, end=reference_start + 1)), None))
        if reason:
            raise ValueError("前一交易日的确认查询尚未完成，请等待数据维护后重试")
    lower, upper = Decimal(daily["low"]), Decimal(daily["high"])
    if not lower.is_finite() or not upper.is_finite() or not 0 < lower < upper:
        raise ValueError("前日高低价不能构成有效区间")
    closed_before = period(stamp, "M5", phase)[0]
    recent = chart_page(db, composite.id, "M5", before=closed_before, count=1,
                        revision_id=revision.id, now=stamp)["bars"]
    baseline = recent[-1] if recent and recent[-1].get("source_confirmed") else None
    outside = bool(baseline and not lower <= Decimal(baseline["close"]) <= upper)
    # expires_at is exclusive throughout the existing evaluator and settlement.
    # +1ms includes the M5 closing exactly at day_end, never the next M5 close.
    zone = ZoneInfo("America/New_York") if phase == "ny17" else UTC
    reference_date = instant(reference_end - 1).astimezone(zone).date().isoformat()
    return {"kind": "previous_day", "lower": str(lower), "upper": str(upper),
            "reference_date": reference_date, "reference_start": reference_start,
            "reference_end": reference_end, "day_end": day_end, "expires_at": day_end + 1,
            "calendar": phase, "outside": outside, "composite_revision_id": revision.id,
            "phone_available": phone_reason(db) is None}
