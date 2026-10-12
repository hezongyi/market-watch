"""Bounded session activity, shared warming and latest-bar subscriptions.

The same cache interface serves foreground reads and background tasks. Each warm
step issues at most one provider page; it never recursively activates interests.
"""

import hashlib
import json
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor

from sqlalchemy import delete, func, select, text

from . import provider_cache as cache
from . import provider_chart as upstream
from .chart_calculation_history import calculation_rows
from .chart_indicators import calculate, history_requirement
from .config import settings
from .market_resources import lane
from .provider_capabilities import enabled_sources, page_capacity, poll_seconds
from .provider_capabilities import frames as source_frames
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    ProviderBar,
    ProviderDataset,
    ProviderInterest,
    now_ms,
    transaction,
    uid,
)

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
    frames = (focus.timeframe,) + tuple(f for f in PERIODS if f != focus.timeframe and f in source_frames(focus.source))
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
        width = len(frames)
        targets = [targets[0], right[0], *targets[1:width],
                   targets[width], right[1], *targets[width+1:2*width]]
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
    if frame not in source_frames(meta["source"]):
        raise ValueError("此源不支持该原生周期")
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
    swing_results = {}
    now = now_ms()
    with cache.budget_transaction(isolation_level="REPEATABLE READ") as db:
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
            if not bars and dataset.metadata_json.get("invalidated_at", 0) > interest.accessed_at:
                result.append({"listener":interest.listener, "type":"reset", "bars":[],
                               "indicators":[], "revision":dataset.revision, "cursor":last,
                               "as_of":dataset.updated_at})
                cursors[interest.listener] = (last, dataset.revision)
            if bars:
                new_last = bars[-1].chart_time
                connected = any(a <= last and new_last < b for a, b in dataset.coverage)
                kind = (
                    "reset"
                    if old_changed or dataset.metadata_json.get("invalidated_at", 0) >
                    cursors.get(interest.listener + ":at", interest.accessed_at)
                    or len(bars) > 2000 or (last and not connected)
                    else "bars"
                )
                indicators = []
                if kind == "bars" and interest.indicators:
                    prefix = list(
                        db.scalars(
                            select(ProviderBar)
                            .where(
                                ProviderBar.dataset_id == dataset.id,
                                ProviderBar.chart_time <= new_last,
                            )
                            .order_by(ProviderBar.chart_time.desc())
                        )
                    )[::-1]
                    prefix_connected = bool(prefix) and any(
                        a <= prefix[0].chart_time and new_last < b
                        for a, b in dataset.coverage
                    )
                    if not prefix_connected:
                        kind = "reset"
                    for spec in interest.indicators if prefix_connected else []:
                        origin=spec.get("calculation_origin")
                        inputs=[row.payload for row in prefix if origin is None or row.start>=origin]
                        if inputs and origin is not None and inputs[0]["start"] != origin:
                            kind="reset"
                            indicators=[]
                            break
                        cache_key = (dataset.id, dataset.revision, origin,
                                     json.dumps(spec.get("params", {}), sort_keys=True))
                        calculated = swing_results.get(cache_key) if spec["name"] == "SWING_SR_V1" else None
                        if calculated is None:
                            calculated = calculate(calculation_rows(inputs, dataset.metadata_json,
                                                                    dataset.metadata_json["id"]), spec, provisional=True)
                            if "presentation" in calculated:
                                calculated["presentation"] = calculated["presentation"] | {
                                    "history_revision": str(dataset.revision), "history_complete": True}
                            if spec["name"] == "SWING_SR_V1":
                                swing_results[cache_key] = calculated
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
            if cache.identity(dataset.metadata_json, dataset.timeframe) != dataset.id:
                continue
            extra = max((history_requirement(spec) for spec in row.indicators), default=0)
            old = groups.get(dataset.id)
            groups[dataset.id] = (
                dataset.metadata_json,
                dataset.timeframe,
                max(extra + 3, old[2] if old else 3),
            )
            row.next_poll = now + poll_seconds(dataset.source) * 1000
        # Database-owned demands outlive browser subscription expiry. They share
        # the same source/dataset acquisition turn and existing source budgets.
        from .chart_alert_service import AlertConfig
        for alert, version, dataset in db.execute(
            select(ChartAlert, ChartAlertVersion, ProviderDataset).join(
                ChartAlertVersion,
                (ChartAlertVersion.alert_id == ChartAlert.id)
                & (ChartAlertVersion.version == ChartAlert.version),
            ).join(ProviderDataset, ProviderDataset.id == ChartAlertVersion.dataset_id).where(
                ChartAlert.status == "active",
            )
        ):
            if source and dataset.source != source:
                continue
            if cache.identity(dataset.metadata_json, dataset.timeframe) != dataset.id:
                alert.health, alert.health_reason = "blocked", "平台账户或数据集身份已改变，需显式编辑告警"
                continue
            if alert.expires_at is not None and alert.expires_at <= now:
                # The locked alert evaluator owns lifecycle transitions. This
                # acquisition snapshot may race an edit extending expiry.
                continue
            if dataset.latest_at + poll_seconds(dataset.source) * 1000 > now:
                continue
            config = AlertConfig.model_validate(version.config)
            checkpoint = alert.state.get("sequence", alert.effective_at)
            missing = max(0, now - checkpoint) // upstream.FRAME_MS[dataset.timeframe] + 3
            old = groups.get(dataset.id)
            groups[dataset.id] = (
                dataset.metadata_json, dataset.timeframe,
                max(min(20_000, config.warmup() + missing), old[2] if old else 3),
            )
    for key, (meta, frame, count) in groups.items():
        if meta["source"] == "yahoo" and not settings.yahoo_enabled:
            continue
        try:
            if meta["source"] == "yahoo":
                from .yahoo_catalog import chart_metadata
                meta = chart_metadata(meta["id"])
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
    if source == "yahoo" and not settings.yahoo_enabled:
        return after, False
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
            cap = page_capacity(source)
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
        target["done"] = satisfied or state["window_limit"]
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
    from .storage import NativeHistoryLoad
    # Resolve provider identity outside the cleanup transaction/pool checkout.
    with transaction() as db:
        loads = list(db.scalars(select(NativeHistoryLoad.query_json).where(
            NativeHistoryLoad.state.in_(("waiting", "filling", "ready")),
            NativeHistoryLoad.consumer_until > now, NativeHistoryLoad.deadline > now)))
    history_protected = set()
    for query in loads:
        from . import provider_chart
        meta = provider_chart.metadata(query["instrument"], cached_only=True)
        history_protected.add(cache.identity(meta, query["timeframe"]))
    with transaction() as db:
        db.execute(delete(ProviderInterest).where(ProviderInterest.expires <= now))
        # All finite cross-period targets are owned by their focus interest.
        # Protect those datasets as well as the currently subscribed frame.
        interests = list(db.scalars(select(ProviderInterest).where(ProviderInterest.expires > now)))
        protected = {row.dataset_id for row in interests} | history_protected
        protected.update(db.scalars(
            select(ChartAlertVersion.dataset_id).join(
                ChartAlert, (ChartAlert.id == ChartAlertVersion.alert_id)
                & (ChartAlert.version == ChartAlertVersion.version),
            ).where(ChartAlert.status.in_(["active", "paused"]),
                    ChartAlertVersion.dataset_id.is_not(None))
        ))
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
    from .yahoo_catalog import seed
    seed()
    _EXECUTOR = ThreadPoolExecutor(max_workers=2*len(enabled_sources())+2, thread_name_prefix="provider")

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

    def alerts():
        from .alert_monitor import run
        run(_STOP)

    _FUTURES = [_EXECUTOR.submit(warmer, source) for source in enabled_sources()]
    _FUTURES.extend(_EXECUTOR.submit(live, source) for source in enabled_sources())
    _FUTURES.append(_EXECUTOR.submit(janitor))
    _FUTURES.append(_EXECUTOR.submit(alerts))


def stop():
    global _EXECUTOR
    _STOP.set()
    if _EXECUTOR:
        _EXECUTOR.shutdown(wait=True)
        _EXECUTOR = None


_QUOTE_LOCK = threading.Lock()
_QUOTE_CACHE = {}
_QUOTE_INFLIGHT = {}


def yahoo_quote(meta, *, deadline=None):
    """Request-driven expiration and in-flight merge; no independent quote worker."""
    from .provider_yahoo import quote
    deadline = deadline or time.monotonic()+settings.provider_request_seconds
    key = meta["id"]
    with _QUOTE_LOCK:
        old = _QUOTE_CACHE.get(key)
        if old and old[0] > time.monotonic():
            return dict(old[1])
        future = _QUOTE_INFLIGHT.get(key)
        owner = future is None
        if owner:
            future = Future()
            _QUOTE_INFLIGHT[key] = future
    if not owner:
        return dict(future.result(timeout=max(0,deadline-time.monotonic())))
    try:
        with lane("chart"):
            result = quote(meta, deadline=deadline)
        with _QUOTE_LOCK:
            _QUOTE_CACHE[key] = (time.monotonic()+settings.yahoo_poll_seconds,result)
            while len(_QUOTE_CACHE)>250:
                _QUOTE_CACHE.pop(next(iter(_QUOTE_CACHE)))
        future.set_result(result)
        return dict(result)
    except Exception as error:
        if old:
            result = {**old[1], "status":"fetch_failed"}
            with _QUOTE_LOCK:
                _QUOTE_CACHE[key] = (time.monotonic()+settings.yahoo_poll_seconds,result)
            future.set_result(result)
            return result
        future.set_exception(error)
        raise
    finally:
        with _QUOTE_LOCK:
            _QUOTE_INFLIGHT.pop(key,None)
