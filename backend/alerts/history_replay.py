"""Fixed replay inputs read the same immutable period artifacts as charts."""

from collections import deque

from sqlalchemy import select

from .history_artifacts import iter_artifact, published_artifact
from .replay_history import pack_history
from .storage import (
    HistoryReclamation,
    HistoryVersion,
    MarketDataset,
    Replay,
)


def version_records(db, version_id, frame, end):
    """Same published bars as charts, excluding buckets beyond replay cutoff."""
    for row in iter_artifact(db, version_id, frame, end=end):
        if row["end"] <= end:
            yield {**row, "revision": 1}


def create_replay(db, instrument, version_id, frame, start, end):
    version = db.get(HistoryVersion, version_id)
    if not version or version.status != "published":
        raise ValueError("请选择已发布的历史数据集版本")
    # Serialize the reference before scanning history, using the same row as
    # reclamation. This avoids reading disappearing chunks before final flush.
    db.scalar(select(MarketDataset).where(MarketDataset.id == version.dataset_id).with_for_update())
    if db.get(HistoryReclamation, version_id):
        raise ValueError("所选历史版本已回收，请选择可用版本")
    dataset = db.get(MarketDataset, version.dataset_id)
    if dataset.instrument_id != instrument.id:
        raise ValueError("回测版本与品种身份不匹配")
    if not version.start <= start < end <= version.end:
        raise ValueError("历史版本未覆盖所选查询区间")
    periods = {period: dict(published_artifact(db, version_id, period).manifest)
               for period in dict.fromkeys((frame, "D1"))}
    context = deque(maxlen=500)
    events = []

    def warmup():
        for record in version_records(db, version_id, frame, end):
            if record["end"] <= start:
                context.append(record)
                yield record
            else:
                events.append(record)
                if len(events) > 20000:
                    raise ValueError("回放超过 20000 根，请缩小日期范围")

    packed, count = pack_history(warmup())
    if not events:
        raise ValueError("所选版本区间没有历史观测，不能替换来源或填造数据")
    days = list(version_records(db, version_id, "D1", end))
    run = Replay(instrument_id=instrument.id, dataset_version=version.id,
        input_manifest={**version.manifest, "replay_input_method": "published_period_artifacts_v1",
            "period_artifacts": periods}, calendar_profile=instrument.calendar_profile,
        timeframe=frame, start=start, end=end, cursor=start, bars=[*context, *events],
        warmup_snapshot=packed, warmup_count=count, days=days, watches=[], signals=[])
    db.add(run)
    db.flush()
    return run
