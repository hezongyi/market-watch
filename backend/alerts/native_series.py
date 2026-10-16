"""Immutable OANDA native configuration; registration never starts collection."""

from datetime import timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from .storage import SourceSeries, instant, ms


class OandaParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    price: Literal["B", "A", "M"] = "B"
    smooth: bool = False
    dailyAlignment: int = Field(default=17, ge=0, le=23)
    alignmentTimezone: str = Field(default="America/New_York", min_length=1, max_length=64)
    weeklyAlignment: Literal["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] = "Sunday"

    @field_validator("alignmentTimezone")
    @classmethod
    def timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("请输入有效的 IANA 时区") from None
        return "UTC" if value in ("Etc/UTC", "Etc/GMT", "GMT", "UTC") else value


DEFAULTS = OandaParameters().model_dump()
BASES = {"B": "bid", "A": "ask", "M": "mid"}


def parameters(meta):
    return OandaParameters.model_validate(meta.get("native_parameters", DEFAULTS)).model_dump()


def source_identity(meta, values, *, timeframe=None):
    from .history_catalog import account_scope
    from .provider_chart import OANDA_FRAMES
    from .source_registry import SourceIdentity

    values = OandaParameters.model_validate(values).model_dump()
    return SourceIdentity(source="oanda", channel="v20", environment="practice",
        account_scope=account_scope(), provider_symbol=meta["symbol"], basis=BASES[values["price"]],
        parameters={**values, **({"granularity": OANDA_FRAMES[timeframe]} if timeframe else {})})


def register(meta, values):
    from .source_registry import _insert
    from .storage import transaction

    if meta["source"] != "oanda":
        raise ValueError("请选择 OANDA 平台品种配置原生参数")
    if meta.get("native_series_id"):
        from .provider_chart import metadata
        meta = metadata("OANDA:" + meta["symbol"])
    values = OandaParameters.model_validate(values).model_dump()
    if values == DEFAULTS:
        return meta
    identity = source_identity(meta, values)
    ticker = "NATIVE:" + identity.key[:32]
    with transaction() as db:
        collisions = list(db.scalars(select(SourceSeries).where(SourceSeries.id.startswith(identity.key[:32]))))
        if any(row.id != identity.key or row.identity != identity.model_dump() for row in collisions):
            raise ValueError("原生配置身份冲突")
        db.execute(_insert(db)(SourceSeries).values(id=identity.key, identity=identity.model_dump())
            .on_conflict_do_nothing(index_elements=["id"]))
    return configured_metadata(ticker)


def configured_metadata(ticker):
    import re

    from .history_catalog import account_scope
    from .provider_chart import metadata
    from .storage import transaction

    if not re.fullmatch(r"NATIVE:[a-f0-9]{32}", ticker):
        raise ValueError("无效原生配置身份")
    with transaction() as db:
        records = list(db.scalars(select(SourceSeries).where(SourceSeries.id.startswith(ticker[7:])).limit(2)))
        if len(records) != 1:
            raise ValueError("原生配置不存在或身份冲突")
        record = records[0]
        identity, key = dict(record.identity), record.id
    if (identity["source"] != "oanda" or identity["channel"] != "v20" or
            identity["environment"] != "practice" or identity["account_scope"] != account_scope()):
        raise ValueError("原生配置不属于当前 OANDA 账户与环境")
    values = OandaParameters.model_validate(identity["parameters"]).model_dump()
    meta = metadata("OANDA:" + identity["provider_symbol"])
    if source_identity(meta, values).key != key:
        raise ValueError("原生配置身份不匹配")
    aligned = all(values[k] == DEFAULTS[k] for k in ("dailyAlignment", "alignmentTimezone", "weeklyAlignment"))
    description = (f"{BASES[values['price']]} · {'平滑' if values['smooth'] else '非平滑'} · "
        f"{values['alignmentTimezone']} {values['dailyAlignment']:02d}:00 · {values['weeklyAlignment']}")
    return {**meta, "id": ticker, "native_series_id": key, "native_parameters": values,
        "basis": BASES[values["price"]], "calendar": "ny17" if aligned else "native",
        "timezone": "Etc/UTC" if values["alignmentTimezone"] == "UTC" else values["alignmentTimezone"],
        # Provider observations establish trading availability, not the chosen
        # alignment timezone. A display session must never suppress source bars.
        "session": "24x7", "price_description": description,
        "native_identity": identity, "name": meta["name"] + " · " + description}


def session_start(start, values):
    local = instant(start).astimezone(ZoneInfo(values["alignmentTimezone"]))
    boundary = local.replace(hour=values["dailyAlignment"], minute=0, second=0, microsecond=0)
    if local < boundary:
        boundary -= timedelta(days=1)
    return ms(boundary)


def chart_label(start, frame, values):
    if frame not in ("D1", "W1", "MN"):
        return start
    local = instant(start).astimezone(ZoneInfo(values["alignmentTimezone"]))
    day = local.date()
    if frame == "MN":
        # OANDA monthly intervals open at the daily alignment on the last
        # calendar day of the preceding month (also with UTC midnight).
        day = (day + timedelta(days=1)).replace(day=1)
    elif values["dailyAlignment"] > 0 and local.hour >= values["dailyAlignment"]:
        day += timedelta(days=1)
    return ms(instant(0).replace(year=day.year, month=day.month, day=day.day))


def chart_ceiling(observed, frame, values):
    """Exclusive display ceiling for source candles already observable now."""
    opening = session_start(observed, values)
    if frame == "W1":
        local = instant(opening).astimezone(ZoneInfo(values["alignmentTimezone"]))
        weekday = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday").index(
            values["weeklyAlignment"])
        opening = ms(local - timedelta(days=(local.weekday() - weekday) % 7))
    return max(observed + 1, chart_label(opening, frame, values) + 1)


def interval_end(start, frame, values):
    from .provider_chart import FRAME_MS

    local = instant(start).astimezone(ZoneInfo(values["alignmentTimezone"]))
    if frame == "MN":
        month = (local.date() + timedelta(days=1)).replace(day=1)
        year, number = (month.year + 1, 1) if month.month == 12 else (month.year, month.month + 1)
        boundary = local.replace(year=year, month=number, day=1,
            hour=values["dailyAlignment"], minute=0, second=0, microsecond=0) - timedelta(days=1)
        return ms(boundary)
    if frame in ("D1", "W1"):
        return ms(local + timedelta(days=1 if frame == "D1" else 7))
    if frame == "H4":
        # H4 is daily aligned; the last bucket owns the remainder of a
        # DST-short or DST-long daily interval.
        opening = session_start(start, values)
        boundary = instant(opening).astimezone(local.tzinfo) + timedelta(days=1)
        return ms(boundary) if start - opening >= 20 * 3600000 else min(start + FRAME_MS[frame], ms(boundary))
    return start + FRAME_MS[frame]
