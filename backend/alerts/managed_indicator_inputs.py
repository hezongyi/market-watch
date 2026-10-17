"""Bounded published inputs using the existing exact provider computation engine.

Publication revisions fence snapshots. Per-row monotonic revision credentials
prove an unchanged retained prefix before accepting an appended mutable tail.
No database connection is held while numerical work runs.
"""

import bisect
import threading
from collections import OrderedDict

from sqlalchemy import func, select

from .provider_indicator_inputs import Inputs
from .storage import ChartPublishedBar

MAX_ROWS = 250_000
MAX_ENTRIES = 16
_LOCK = threading.Lock()
_INPUTS = OrderedDict()


def _credential(db, instrument, timeframe, left, right):
    # Published rows are inserted or updated, never replaced with reset
    # revisions by the publisher. Every correction increases this credential.
    return tuple(
        db.execute(
            select(func.count(), func.sum(ChartPublishedBar.revision)).where(
                ChartPublishedBar.instrument_id == instrument,
                ChartPublishedBar.timeframe == timeframe,
                ChartPublishedBar.start >= left,
                ChartPublishedBar.start < right,
            )
        ).one()
    )


def freeze(db, inst, pub, body, *, ceiling):
    from .provider_history_policy import CapacityExceeded

    left = max(pub.start, body.dataset_start or pub.start)
    key = (db.get_bind(), "managed", inst.id, body.timeframe, left)
    stats = {"input_cache": "miss", "sql_payload_rows": 0, "prefix_credential_queries": 0}
    with _LOCK:
        previous = _INPUTS.get(key)
    same = previous and previous["revision"] <= pub.revision
    reusable = same and previous["revision"] == pub.revision
    if same and not reusable and previous["rows"]:
        stats["prefix_credential_queries"] += 1
        reusable = previous["credential"] == _credential(
            db, inst.id, body.timeframe, left, previous["rows"][-1]["start"]
        )
    if (
        reusable
        and previous["revision"] == pub.revision
        and (previous["ceiling"] >= ceiling or previous["ceiling"] >= pub.end - 1)
    ):
        rows, epoch = previous["rows"], previous["epoch"]
        stats["input_cache"] = "hit"
    else:
        incremental = reusable and previous["rows"] and previous["rows"][-1]["start"] <= ceiling
        start = previous["rows"][-1]["start"] if incremental else left
        loaded = list(
            db.scalars(
                select(ChartPublishedBar.payload)
                .where(
                    ChartPublishedBar.instrument_id == inst.id,
                    ChartPublishedBar.timeframe == body.timeframe,
                    ChartPublishedBar.start >= start,
                    ChartPublishedBar.start <= ceiling,
                    ChartPublishedBar.start < pub.end,
                )
                .order_by(ChartPublishedBar.start)
                .limit(MAX_ROWS + 1)
            )
        )
        stats["sql_payload_rows"] = len(loaded)
        rows = [*previous["rows"][:-1], *loaded] if incremental else loaded
        if len(rows) > MAX_ROWS:
            raise CapacityExceeded("自建指标固定前缀超过历史容量，请缩小数据集范围后重试")
        epoch = previous["epoch"] if incremental else ("publication", pub.revision)
        stats["input_cache"] = "append" if incremental else "miss"
        credential = (
            _credential(db, inst.id, body.timeframe, left, rows[-1]["start"]) if rows else (0, None)
        )
        stats["prefix_credential_queries"] += int(bool(rows))
        value = {
            "rows": rows,
            "epoch": epoch,
            "revision": pub.revision,
            "credential": credential,
            "ceiling": ceiling,
        }
        with _LOCK:
            current = _INPUTS.get(key)
            if current is None or current["revision"] <= pub.revision:
                _INPUTS[key] = value
                _INPUTS.move_to_end(key)
            while _INPUTS and (
                len(_INPUTS) > MAX_ENTRIES
                or sum(len(v["rows"]) for v in _INPUTS.values()) > MAX_ROWS
            ):
                _INPUTS.popitem(last=False)
    end = bisect.bisect_right(rows, ceiling, key=lambda row: row["start"])
    rows = rows if end == len(rows) else rows[:end]
    return Inputs(rows, key, epoch, pub.revision), stats
