"""Bounded session activity, shared warming and latest-bar subscriptions.

The same cache interface serves foreground reads and background tasks. Each warm
step issues at most one provider page; it never recursively activates interests.
"""

import hashlib
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import delete, func, select, text

from . import provider_cache as cache
from . import provider_chart as upstream
from .chart_indicators import calculate, history_requirement
from .config import settings
from .market_resources import lane
from .storage import ProviderBar, ProviderDataset, ProviderInterest, now_ms, transaction, uid

PERIODS = ("D1", "W1", "H4", "M5", "M1", "MN", "H1", "M30", "M15")
_STOP = threading.Event()
_EXECUTOR = None
_FUTURES = []
log = logging.getLogger(__name__)


def interest_id(client, listener):
    return hashlib.sha256((client + "|" + listener).encode()).hexdigest()


def activate(client, key, before, count, *, latest=False, db=None):
    if not client:
        return
    if db is not None:
        cache.database_budget(db)
        return _activate(db, client, key, before, count, latest=latest)
    with cache.budget_transaction() as owned:
        return _activate(owned, client, key, before, count, latest=latest)


def _activate(db, client, key, before, count, *, latest=False):
    now = now_ms()
    if cache.DEADLINE.get() is not None and db.get_bind().dialect.name == "postgresql":
        # Optional activation must not hold completed bars behind any
        # dataset, interest, or cleanup write lock. A later read retries it.
        db.execute(text("SELECT set_config('lock_timeout', '1', true)"))
    # Serialize activations even when the interest row has not been created
    # yet. Workers lock only the interest during their short CAS writeback.
    focus = db.scalar(select(ProviderDataset).where(ProviderDataset.id == key).with_for_update())
    # One latest and one historical focus per dataset/client; requests for
    # other panes remain separate. Fixed anchor targets do not chase now.
    listener = "read:" + key + (":latest" if latest else ":history")
    ident = interest_id(client, listener)
    old = db.scalar(select(ProviderInterest).where(ProviderInterest.id == ident).with_for_update())
    if old and (latest or abs(old.cursor - before) < 1000):
        old.expires = now + settings.provider_activity_seconds * 1000
        old.accessed_at = now
        targets = [dict(target) for target in old.targets]
        for target in targets:
            if target["frame"] != focus.timeframe or "after" in target:
                continue
            # Latest uses its original fixed anchor, never moving now.
            goal = target.get("goal", settings.provider_basic_bars)
            wanted = max(goal, count) if latest else goal + count
            if wanted <= target["count"]:
                continue
            target["count"] = wanted
            target["generation"] = target.get("generation", 0) + 1
            interval = next((r for r in focus.coverage
                             if r[0] < target["before"] <= r[1]), None)
            actual = db.scalar(select(func.count()).select_from(ProviderBar).where(
                ProviderBar.dataset_id == key,
                ProviderBar.chart_time >= (interval[0] if interval else target["before"]),
                ProviderBar.chart_time < target["before"],
            ))
            target["done"] = bool(interval and
                                  (actual >= wanted or focus.earliest and interval[0] == 0))
            target["next_at"] = 0
        old.targets = targets
        return
    frames = (focus.timeframe,) + tuple(f for f in PERIODS if f != focus.timeframe)
    targets = []
    for goal in (settings.provider_basic_bars, settings.provider_depth_bars):
        for frame in frames:
            targets.append(
                {
                    "frame": frame,
                    "before": before,
                    "count": max(goal, count if frame == focus.timeframe else 0),
                    "goal": goal,
                    "done": False,
                    "next_at": 0,
                    "attempts": 0,
                }
            )
    if not latest:
        # Historical left buffer includes the requested window. Right
        # buffer is a separate bounded anchor, clamped to the present.
        for goal in (settings.provider_basic_bars, settings.provider_depth_bars):
            targets.append(
                {
                    "frame": focus.timeframe,
                    "before": min(now + 1, before + goal * upstream.FRAME_MS[focus.timeframe]),
                    "after": before,
                    "until": now + 1,
                    "count": goal,
                    "done": False,
                    "next_at": 0,
                    "attempts": 0,
                }
            )
        for target in targets:
            if target["frame"] == focus.timeframe and target["before"] == before:
                target["count"] = target["goal"] + count
        # Neighbor buffers precede cross-period work in each round.
        right = targets[-2:]
        targets = [targets[0], right[0], *targets[1:9], targets[9], right[1], *targets[10:18]]
    task_id = uid()
    for target in targets:
        target["task_id"] = task_id
        target["generation"] = 0
    values = dict(
        dataset_id=key,
        expires=now + settings.provider_activity_seconds * 1000,
        accessed_at=now,
        targets=targets,
        cursor=before,
    )
    if old:
        for field, value in values.items():
            setattr(old, field, value)
    else:
        db.add(
            ProviderInterest(
                id=ident,
                client=client,
                listener=listener,
                subscribed=False,
                revision=0,
                next_poll=0,
                **values,
            )
        )
    # Bound per-session targets, including abandoned rapid symbol changes.
    stale = list(
        db.scalars(
            select(ProviderInterest)
            .where(
                ProviderInterest.client == client,
                ProviderInterest.subscribed.is_(False),
            )
            .order_by(ProviderInterest.accessed_at.desc())
            .offset(settings.provider_interest_limit)
        )
    )
    for item in stale:
        db.delete(item)


def subscribe(
    client, listener, instrument, frame, cursor=0, revision=0, observed_at=0, indicators=None
):
    meta = upstream.metadata(instrument)
    key = cache.ensure(meta, frame)
    ident = interest_id(client, listener)
    now = now_ms()
    with transaction() as db:
        row = db.get(ProviderInterest, ident)
        values = dict(
            dataset_id=key,
            subscribed=True,
            expires=now + settings.provider_subscription_seconds * 1000,
            accessed_at=observed_at or now,
            cursor=cursor,
            revision=revision,
            targets=[],
            next_poll=0,
            error=None,
            indicators=indicators or [],
        )
        if row:
            for field, value in values.items():
                setattr(row, field, value)
        else:
            db.add(ProviderInterest(id=ident, client=client, listener=listener, **values))
        # Existing finite read targets remain while this dataset is subscribed.
    return {"id": ident, "dataset_id": key}


def unsubscribe(client, listener):
    with transaction() as db:
        db.execute(
            delete(ProviderInterest).where(ProviderInterest.id == interest_id(client, listener))
        )


def renew(client):
    now = now_ms()
    with transaction() as db:
        rows = list(
            db.scalars(
                select(ProviderInterest).where(
                    ProviderInterest.client == client,
                    ProviderInterest.subscribed.is_(True),
                )
            )
        )
        subscribed = {row.dataset_id for row in rows}
        for row in rows:
            row.expires = now + settings.provider_subscription_seconds * 1000
        for row in db.scalars(
            select(ProviderInterest).where(
                ProviderInterest.client == client,
                ProviderInterest.subscribed.is_(False),
                ProviderInterest.dataset_id.in_(subscribed),
            )
        ):
            row.expires = now + settings.provider_activity_seconds * 1000


def events(client, cursors):
    """Snapshot only: SSE never fetches upstream or holds DB during its wait."""
    result = []
    now = now_ms()
    with transaction() as db:
        rows = list(
            db.scalars(
                select(ProviderInterest).where(
                    ProviderInterest.client == client,
                    ProviderInterest.subscribed.is_(True),
                    ProviderInterest.expires > now,
                )
            )
        )
        for interest in rows:
            dataset = db.get(ProviderDataset, interest.dataset_id)
            if interest.error:
                if cursors.get(interest.listener + ":error") != interest.error:
                    result.append(
                        {
                            "listener": interest.listener,
                            "type": "error",
                            "error": "平台行情暂不可用，后台重试中",
                            "reason": interest.error,
                        }
                    )
                    cursors[interest.listener + ":error"] = interest.error
            else:
                cursors.pop(interest.listener + ":error", None)
            last, revision = cursors.get(interest.listener, (interest.cursor, interest.revision))
            if dataset.revision == revision:
                continue
            bars = list(
                db.scalars(
                    select(ProviderBar)
                    .where(
                        ProviderBar.dataset_id == dataset.id,
                        ProviderBar.chart_time >= last,
                    )
                    .order_by(ProviderBar.chart_time)
                    .limit(2001)
                )
            )
            # Old bars changed since the history response require public reload,
            # while new older cache rows (revision=1) do not invalidate a chart.
            old_changed = (
                db.scalar(
                    select(ProviderBar.start)
                    .where(
                        ProviderBar.dataset_id == dataset.id,
                        ProviderBar.chart_time < last,
                        ProviderBar.revision > 1,
                        ProviderBar.changed_at
                        > cursors.get(interest.listener + ":at", interest.accessed_at),
                    )
                    .limit(1)
                )
                is not None
            )
            if bars:
                new_last = bars[-1].chart_time
                connected = any(a <= last and new_last < b for a, b in dataset.coverage)
                kind = (
                    "reset"
                    if old_changed or len(bars) > 2000 or (last and not connected)
                    else "bars"
                )
                indicators = []
                if kind == "bars" and interest.indicators:
                    extra = max(history_requirement(spec) for spec in interest.indicators)
                    prefix = list(
                        db.scalars(
                            select(ProviderBar)
                            .where(
                                ProviderBar.dataset_id == dataset.id,
                                ProviderBar.chart_time <= new_last,
                            )
                            .order_by(ProviderBar.chart_time.desc())
                            .limit(len(bars) + extra)
                        )
                    )[::-1]
                    prefix_connected = bool(prefix) and any(
                        a <= prefix[0].chart_time and new_last < b
                        for a, b in dataset.coverage
                    )
                    if not prefix_connected:
                        kind = "reset"
                    for spec in interest.indicators if prefix_connected else []:
                        calculated = calculate([row.payload for row in prefix], spec)
                        indicators.append(
                            {
                                **calculated,
                                "series": [
                                    {
                                        **series,
                                        "values": [
                                            v
                                            for v in series["values"]
                                            if v["time"] >= bars[0].start
                                        ],
                                    }
                                    for series in calculated["series"]
                                ],
                            }
                        )
                result.append(
                    {
                        "listener": interest.listener,
                        "type": kind,
                        "bars": [row.payload for row in bars] if kind == "bars" else [],
                        "indicators": indicators,
                        "revision": dataset.revision,
                        "cursor": new_last,
                        "as_of": dataset.updated_at,
                    }
                )
                cursors[interest.listener] = (new_last, dataset.revision)
                cursors[interest.listener + ":at"] = dataset.updated_at
    return result


def realtime_step(source=None):
    now = now_ms()
    with transaction() as db:
        active = list(
            db.scalars(
                select(ProviderInterest)
                .where(
                    ProviderInterest.subscribed.is_(True),
                    ProviderInterest.expires > now,
                    ProviderInterest.next_poll <= now,
                )
                .order_by(ProviderInterest.next_poll)
            )
        )
        groups = {}
        for row in active:
            dataset = db.get(ProviderDataset, row.dataset_id)
            if source and dataset.source != source:
                continue
            extra = max((history_requirement(spec) for spec in row.indicators), default=0)
            old = groups.get(dataset.id)
            groups[dataset.id] = (
                dataset.metadata_json,
                dataset.timeframe,
                max(extra + 3, old[2] if old else 3),
            )
            row.next_poll = now + settings.market_poll_seconds * 1000
    for key, (meta, frame, count) in groups.items():
        try:
            with lane("realtime"):
                cache.read(meta, frame, (now_ms() // 1000 + 1) * 1000, count, latest=True)
            with transaction() as db:
                for row in db.scalars(
                    select(ProviderInterest).where(ProviderInterest.dataset_id == key)
                ):
                    row.error = None
        except Exception as exc:
            with transaction() as db:
                for row in db.scalars(
                    select(ProviderInterest).where(ProviderInterest.dataset_id == key)
                ):
                    row.error = type(exc).__name__


def right_status(key, target):
    """A right buffer requires proven coverage and actual future bar count."""
    with transaction() as db:
        dataset = db.get(ProviderDataset, key)
        connected = any(a <= target["after"] and target["before"] <= b for a, b in dataset.coverage)
        actual = db.scalar(select(func.count()).select_from(ProviderBar).where(
            ProviderBar.dataset_id == key,
            ProviderBar.chart_time >= target["after"],
            ProviderBar.chart_time < target["before"],
        ))
    satisfied = connected and (actual >= target["count"] or target["before"] >= target["until"])
    return satisfied, connected, actual


def warm_step(source, after=None):
    if cache.interactive_busy(source):
        return after, False
    now = now_ms()
    with transaction() as db:
        rows = list(
            db.execute(
                select(ProviderInterest, ProviderDataset)
                .join(
                    ProviderDataset,
                    ProviderInterest.dataset_id == ProviderDataset.id,
                )
                .where(
                    ProviderInterest.expires > now,
                    ProviderInterest.subscribed.is_(False),
                    ProviderDataset.source == source,
                )
                .order_by(ProviderInterest.id)
            )
        )
        if after:
            rows = sorted(rows, key=lambda pair: (pair[0].id <= after, pair[0].id))
        candidate = None
        for interest, dataset in rows:
            pending = next(
                (
                    i
                    for i, target in enumerate(interest.targets)
                    if not target["done"] and target["next_at"] <= now
                ),
                None,
            )
            if pending is not None:
                candidate = (
                    interest.id,
                    interest.cursor,
                    pending,
                    dict(interest.targets[pending]),
                    dataset.metadata_json,
                )
                break
    if candidate is None:
        return after, False
    ident, anchor, index, target, meta = candidate
    key = cache.ensure(meta, target["frame"])
    state = cache.snapshot(key, target["before"], target["count"])
    try:
        right = target.get("after")
        if right is not None:
            satisfied, connected, actual = right_status(key, target)
        else:
            satisfied = state["satisfied"]
        if right is not None and connected and not satisfied:
            # Natural duration is only a search estimate. Count real bars and
            # extend past weekends/closures until the finite goal or fixed now.
            extra = max(1, target["count"] - actual) * upstream.FRAME_MS[target["frame"]]
            target["before"] = min(target["until"], target["before"] + extra)
        elif not satisfied:
            before = state["interval"][0] if state["interval"] else target["before"]
            missing = target["count"]
            if right is None and state["interval"]:
                missing -= len(state["bars"])
            cap = 4000 if source == "oanda" else 1000
            cache.fetch_page(
                key,
                meta,
                target["frame"],
                before,
                min(cap, max(1, missing)),
                time.monotonic() + settings.provider_request_seconds,
                kind="history",
            )
            state = cache.snapshot(key, target["before"], target["count"])
            if right is not None:
                satisfied, _, _ = right_status(key, target)
            else:
                satisfied = state["satisfied"]
        target["done"] = satisfied
        target["next_at"] = now_ms() + 1000
    except Exception as exc:
        target["attempts"] += 1
        target["next_at"] = now_ms() + min(60000, 1000 * 2 ** min(6, target["attempts"]))
        target["error"] = type(exc).__name__
    with transaction() as db:
        interest = db.scalar(select(ProviderInterest).where(ProviderInterest.id == ident)
                             .with_for_update())
        if (interest and interest.expires > now_ms() and interest.cursor == anchor
                and index < len(interest.targets)
                and interest.targets[index].get("task_id") == target.get("task_id")
                and interest.targets[index].get("generation", 0) == target.get("generation", 0)):
            targets = list(interest.targets)
            target["count"] = max(target["count"], targets[index]["count"])
            targets[index] = target
            interest.targets = targets
    return ident, True


def cleanup():
    now = now_ms()
    with transaction() as db:
        db.execute(delete(ProviderInterest).where(ProviderInterest.expires <= now))
        # All finite cross-period targets are owned by their focus interest.
        # Protect those datasets as well as the currently subscribed frame.
        interests = list(db.scalars(select(ProviderInterest).where(ProviderInterest.expires > now)))
        protected = {row.dataset_id for row in interests}
        for interest in interests:
            focus = db.get(ProviderDataset, interest.dataset_id)
            for target in interest.targets:
                protected.add(cache.identity(focus.metadata_json, target["frame"]))
        total = db.scalar(select(func.count()).select_from(ProviderBar))
        candidates = list(
            db.scalars(
                select(ProviderDataset)
                .where(
                    ProviderDataset.id.not_in(protected),
                    ProviderDataset.lease_until <= now,
                    ProviderDataset.accessed_at < now - settings.provider_activity_seconds * 1000,
                )
                .order_by(ProviderDataset.accessed_at)
                .limit(20)
                .with_for_update(skip_locked=True)
            )
        )
        for row in candidates:
            expired = row.accessed_at < now - settings.provider_cache_days * 86400000
            if not expired and total <= settings.provider_cache_max_bars:
                break
            count = db.execute(delete(ProviderBar).where(ProviderBar.dataset_id == row.id)).rowcount
            total -= count
            db.delete(row)


def start():
    global _EXECUTOR, _FUTURES
    if _EXECUTOR:
        return
    _STOP.clear()
    _EXECUTOR = ThreadPoolExecutor(max_workers=5, thread_name_prefix="provider")

    def warmer(source):
        after = None
        while not _STOP.is_set():
            progressed = False
            try:
                after, progressed = warm_step(source, after)
            except Exception:
                log.exception("Provider prewarm iteration failed for %s", source)
            # Shared cached goals and boundary checks do not consume an
            # upstream request turn. HTTP rate/concurrency remain enforced by
            # request_slot; idle/interactive iterations still back off.
            _STOP.wait(0.05 if progressed else 1)

    def live(source):
        while not _STOP.is_set():
            try:
                realtime_step(source)
            except Exception:
                log.exception("Provider realtime iteration failed for %s", source)
            _STOP.wait(1)

    def janitor():
        while not _STOP.is_set():
            try:
                cleanup()
            except Exception:
                log.exception("Provider cache cleanup failed")
            _STOP.wait(60)

    _FUTURES = [_EXECUTOR.submit(warmer, source) for source in ("oanda", "binance")]
    _FUTURES.extend(_EXECUTOR.submit(live, source) for source in ("oanda", "binance"))
    _FUTURES.append(_EXECUTOR.submit(janitor))


def stop():
    global _EXECUTOR
    _STOP.set()
    if _EXECUTOR:
        _EXECUTOR.shutdown(wait=True)
        _EXECUTOR = None
