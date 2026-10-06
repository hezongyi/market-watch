"""Aggregate replay inputs exclusively from the selected immutable M1 version."""

from collections import deque
from decimal import Decimal

from .calendar_profile import closures_from
from .chart_series import is_gold
from .domain import Calendar, Candle, aggregate, bucket_bounds, scheduled_open
from .history_versions import snapshot_rows
from .replay_history import pack_history
from .storage import HistoryVersion, MarketDataset, Replay, candle_dict, instant, ms


def version_candles(db, version_id, instrument, frame, end):
    from datetime import timedelta

    calendar = Calendar(instrument.calendar)
    closures = closures_from(instrument.calendar_profile)
    members = []
    active = None

    def output(bounds, values):
        left, right = bounds
        expected = set()
        cursor = left
        while cursor < right:
            if scheduled_open(cursor, calendar, gold=is_gold(instrument.id), closures=closures):
                expected.add(cursor)
            cursor += timedelta(minutes=1)
        result = aggregate(values, left, right, expected_starts=expected)
        return result if result and right <= instant(end) else None

    version = db.get(HistoryVersion, version_id)
    for row in snapshot_rows(db, version_id, end=min(end, version.end)):
        start = instant(row["timestamp"])
        candle = Candle(start, start + timedelta(minutes=1),
            *(Decimal(row[key]) for key in ("open", "high", "low", "close")),
            volume=Decimal(row["volume"]) if row["volume"] is not None else None)
        if frame == "M1":
            yield candle
            continue
        pair = bucket_bounds(start, frame, calendar)
        if active is not None and pair != active:
            result = output(active, members)
            if result:
                yield result
            members = []
        active = pair
        members.append(candle)
    if active:
        result = output(active, members)
        if result:
            yield result


def create_replay(db, instrument, version_id, frame, start, end):
    version = db.get(HistoryVersion, version_id)
    if not version or version.status != "published":
        raise ValueError("请选择已发布的历史数据集版本")
    dataset = db.get(MarketDataset, version.dataset_id)
    if dataset.instrument_id != instrument.id:
        raise ValueError("回测版本与品种身份不匹配")
    if not version.start <= start < end <= version.end:
        raise ValueError("历史版本未覆盖所选查询区间")
    context = deque(maxlen=500)
    events = []

    def warmup():
        for candle in version_candles(db, version_id, instrument, frame, end):
            record = candle_dict(candle)
            if ms(candle.end) <= start:
                context.append(record)
                yield record
            else:
                events.append(record)
                if len(events) > 20000:
                    raise ValueError("回放超过 20000 根，请缩小日期范围")

    packed, count = pack_history(warmup())
    if not events:
        raise ValueError("所选版本区间没有历史观测，不能替换来源或填造数据")
    days = [candle_dict(candle) for candle in version_candles(db, version_id, instrument, "D1", end)]
    run = Replay(instrument_id=instrument.id, dataset_version=version.id,
        input_manifest=version.manifest, calendar_profile=instrument.calendar_profile,
        timeframe=frame, start=start, end=end, cursor=start, bars=[*context, *events],
        warmup_snapshot=packed, warmup_count=count, days=days, watches=[], signals=[])
    db.add(run)
    db.flush()
    return run
