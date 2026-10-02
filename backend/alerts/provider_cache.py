"""Persistent native-period range reads behind the chart API.

All provider I/O happens outside a database transaction. A dataset lease serializes
overlapping observations across processes; its generation fences expired owners.
"""

import hashlib
import json
import logging
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar

from sqlalchemy import exists, literal, select, text, true, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import DBAPIError

from . import provider_chart as upstream
from .chart_indicators import calculate, history_requirement
from .config import settings
from .market_resources import LANE, lane
from .provider_history_policy import CAPACITY, CapacityExceeded, optional_bars
from .storage import ProviderBar, ProviderDataset, now_ms, transaction, uid
from .volume import metadata as volume_metadata

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_READS = {"oanda": 0, "binance": 0}
CANCELLED = ContextVar("provider_request_cancelled", default=None)
DEADLINE = ContextVar("provider_request_deadline", default=None)
log = logging.getLogger(__name__)


def check_cancelled():
    event = CANCELLED.get()
    if event is not None and event.is_set():
        raise TimeoutError("平台读取已取消")


def database_budget(db):
    # Pool checkout timeout is shared configuration. After a delayed checkout,
    # expired workers release without querying data; the API owns HTTP deadline.
    connection = db.connection()
    check_cancelled()
    deadline = DEADLINE.get()
    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("平台数据库读取超过时间预算")
        if connection.dialect.name == "postgresql":
            db.execute(text("SELECT set_config('statement_timeout', :budget, true)"),
                       {"budget": str(max(1, int(remaining * 1000)))})


@contextmanager
def budget_transaction():
    try:
        with transaction() as db:
            database_budget(db)
            yield db
    except DBAPIError as error:
        if getattr(error.orig, "sqlstate", None) in ("57014", "55P03"):
            raise TimeoutError("平台数据库读取超过时间预算") from error
        raise


def interactive_busy(source):
    with _ACTIVE_LOCK:
        return _ACTIVE_READS[source] > 0


def identity(meta, frame):
    environment = (
        hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
        if meta["source"] == "oanda"
        else "binance-public"
    )
    return hashlib.sha256(
        json.dumps(
            [
                meta["source"],
                environment,
                meta["symbol"],
                frame,
                meta["basis"],
                meta["calendar"],
                upstream.ALIGNMENT_VERSION,
                upstream.PAYLOAD_VERSION,
            ]
        ).encode()
    ).hexdigest()


def merge_ranges(ranges):
    merged = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return merged


def ensure(meta, frame):
    key = identity(meta, frame)
    with budget_transaction() as db:
        insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
        db.execute(
            insert(ProviderDataset)
            .values(
                id=key,
                source=meta["source"],
                symbol=meta["symbol"],
                timeframe=frame,
                metadata_json=meta,
                coverage=[],
                earliest=False,
                revision=0,
                updated_at=0,
                latest_at=0,
                accessed_at=now_ms(),
                lease_until=0,
                generation=0,
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
    return key


@contextmanager
def snapshot_transaction(key, before, count, *, observation=None, bounded_limit=None):
    """Bars and dataset metadata share one statement snapshot, including empty data.

    The bounded subquery is independent of coverage; filter it using the coverage
    returned by that same statement, never a preceding READ COMMITTED SELECT.
    """
    bounded = (
        select(ProviderBar.chart_time, ProviderBar.payload)
        .where(ProviderBar.dataset_id == key, ProviderBar.chart_time < before)
        .order_by(ProviderBar.chart_time.desc())
        .limit(bounded_limit or count + 1)
        .subquery()
    )
    changed = literal(False)
    if observation is not None:
        changed = exists(select(ProviderBar.start).where(
            ProviderBar.dataset_id == key,
            ProviderBar.chart_time >= observation.first,
            ProviderBar.chart_time <= observation.last,
            ProviderBar.revision > 1,
            ProviderBar.changed_at > observation.observed_at,
        ))
    statement = (
        select(ProviderDataset.source, ProviderDataset.symbol,
               ProviderDataset.coverage, ProviderDataset.earliest,
               ProviderDataset.updated_at, ProviderDataset.latest_at, ProviderDataset.revision,
               bounded.c.chart_time, bounded.c.payload, changed.label("changed"))
        .select_from(ProviderDataset).outerjoin(bounded, true())
        .where(ProviderDataset.id == key).order_by(bounded.c.chart_time)
    )
    with budget_transaction() as db:
        records = db.execute(statement).all()
        if not records:
            raise ValueError("平台缓存已清理，请重试")
        metadata = records[0]
        ranges = metadata.coverage
        interval = next((r for r in ranges if r[0] < before <= r[1]), None)
        preceding = next((r for r in reversed(ranges) if r[1] < before), None)
        readable = interval or preceding
        rows = [r.payload for r in records
                if readable and r.chart_time is not None and r.chart_time >= readable[0]]
        boundary = bool(readable and metadata.earliest and readable[0] == 0 and len(rows) <= count)
        # Access is housekeeping, not part of the published observation version.
        # Housekeeping skips a busy dataset row instead of blocking delivery.
        touched = select(ProviderDataset.id).where(ProviderDataset.id == key)
        if db.get_bind().dialect.name == "postgresql":
            touched = touched.with_for_update(skip_locked=True)
        db.execute(update(ProviderDataset).where(ProviderDataset.id.in_(touched))
                   .values(accessed_at=now_ms()))
        yield db, {
            **volume_metadata(metadata.source, metadata.symbol),
            "bars": rows[-count:],
            "history_boundary": boundary,
            "has_more": not boundary,
            "as_of": metadata.updated_at,
            "latest_at": metadata.latest_at,
            "cache_revision": metadata.revision,
            "interval": interval,
            "preceding": preceding,
            "satisfied": bool(interval and (len(rows) >= count or boundary)),
            **({"history_revalidation": {"changed": bool(metadata.changed)}}
               if observation is not None else {}),
        }


def snapshot(key, before, count, *, observation=None, bounded_limit=None):
    with snapshot_transaction(key, before, count, observation=observation,
                              bounded_limit=bounded_limit) as (_, state):
        return state


def claim(key):
    with budget_transaction() as db:
        now = now_ms()
        token = uid()
        generation = db.scalar(
            update(ProviderDataset)
            .where(
                ProviderDataset.id == key,
                ProviderDataset.lease_until <= now,
            )
            .values(
                lease_token=token,
                lease_until=now + 30000,
                generation=ProviderDataset.generation + 1,
            )
            .returning(ProviderDataset.generation)
        )
        return (token, generation) if generation is not None else None


def release(key, lease):
    # Cleanup must survive request cancellation/expiry. One fenced UPDATE needs
    # no preceding SELECT and cannot release a successor's lease.
    try:
        with transaction() as db:
            if db.get_bind().dialect.name == "postgresql":
                db.execute(text("SELECT set_config('statement_timeout', '250', true)"))
            db.execute(update(ProviderDataset).where(
                ProviderDataset.id == key,
                ProviderDataset.lease_token == lease[0],
                ProviderDataset.generation == lease[1],
            ).values(lease_token=None, lease_until=0))
    except DBAPIError as error:
        if getattr(error.orig, "sqlstate", None) not in ("57014", "55P03"):
            raise
        # Contention cannot mask the original read error. The persisted lease
        # still has its normal expiry; no cleanup retry loop is introduced.
        log.warning("Provider lease cleanup timed out; normal lease expiry retained")


def commit_page(key, lease, page, before, observed_at, *, latest=False):
    """Commit bars and only the range proven by this successful count/to page."""
    rows = page["bars"]
    boundary = page["history_boundary"]
    start = rows[0]["chart_time"] if rows else before
    if boundary:
        start = 0
    changed = []
    with budget_transaction() as db:
        dataset = db.scalar(
            select(ProviderDataset).where(ProviderDataset.id == key).with_for_update()
        )
        if (dataset.lease_token, dataset.generation) != lease or dataset.lease_until <= now_ms():
            raise TimeoutError("平台取数租约已失效，请重试")
        existing = (
            {
                r.start: r
                for r in db.scalars(
                    select(ProviderBar).where(
                        ProviderBar.dataset_id == key,
                        ProviderBar.start.in_([b["start"] for b in rows]),
                    )
                )
            }
            if rows
            else {}
        )
        values = []
        for bar in rows:
            old = existing.get(bar["start"])
            if old and (old.observed_at > observed_at or old.complete and not bar["complete"]):
                continue
            if old and old.payload.get("volume") is not None and bar.get("volume") is None and all(
                    old.payload.get(k) == bar.get(k) for k in ("open", "high", "low", "close", "complete", "end")):
                bar = {**bar, "volume": old.payload.get("volume"),
                       "volume_complete": old.payload.get("volume_complete", False)}
            revision = 1
            if old:
                revision = old.revision + (old.payload != bar)
                if old.payload != bar:
                    changed.append(bar["chart_time"])
            values.append(
                dict(
                    dataset_id=key,
                    start=bar["start"],
                    chart_time=bar["chart_time"],
                    complete=bar["complete"],
                    payload=bar,
                    observed_at=observed_at,
                    changed_at=observed_at if not old or old.payload != bar else old.changed_at,
                    revision=revision,
                )
            )
        if values:
            insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
            stmt = insert(ProviderBar).values(values)
            db.execute(
                stmt.on_conflict_do_update(
                    index_elements=["dataset_id", "start"],
                    set_={
                        field: getattr(stmt.excluded, field)
                        for field in (
                            "chart_time",
                            "complete",
                            "payload",
                            "observed_at",
                            "changed_at",
                            "revision",
                        )
                    },
                )
            )
        if start < before:
            proven = page.get("coverage", [[start, before]])
            if any(a < 0 or b > before or b <= a for a, b in proven):
                raise ValueError("平台覆盖证明无效")
            dataset.coverage = merge_ranges(dataset.coverage + proven)
        dataset.earliest = dataset.earliest or boundary
        dataset.updated_at = max(dataset.updated_at, observed_at)
        if latest:
            dataset.latest_at = max(dataset.latest_at, observed_at)
        if values:
            dataset.revision += 1
    return changed


def fetch_page(key, meta, frame, before, count, deadline, *, kind="chart", latest=False,
               optional=0):
    lease_started = time.monotonic()
    while time.monotonic() < deadline:
        check_cancelled()
        lease = claim(key)
        if lease:
            break
        time.sleep(0.05)
    else:
        raise TimeoutError("平台取数等待超过预算")
    try:
        upstream.record_timing("lease_wait", lease_started)
        # Another owner may have supplied the exact missing interval meanwhile.
        cached = snapshot(key, before, count)
        if cached["satisfied"] and (
            not latest or now_ms() - cached["latest_at"] < settings.provider_fresh_seconds * 1000
        ):
            return cached
        observed_at = now_ms()
        check_cancelled()
        with lane(kind):
            kwargs = {"optional": optional} if optional else {}
            page = upstream.native_page(meta, frame, before, count, deadline=deadline, **kwargs)
        commit_started = time.monotonic()
        commit_page(key, lease, page, before, observed_at, latest=latest)
        upstream.record_timing("database_commit", commit_started)
        return page
    finally:
        release(key, lease)


def _read(meta, frame, before, count, *, latest=False, deadline=None, on_ready=None):
    if frame not in upstream.FRAMES or not 1 <= count <= 20000:
        raise ValueError("平台请求根数须在1至20000之间")
    deadline = deadline or DEADLINE.get() or time.monotonic() + settings.provider_request_seconds
    key = ensure(meta, frame)
    cap = 4000 if meta["source"] == "oanda" else 1000
    fetched = False
    for _ in range(40):
        check_cancelled()
        if time.monotonic() >= deadline:
            raise TimeoutError("平台读取超过时间预算，请重试")
        with snapshot_transaction(key, before, count) as (db, cached):
            fresh = (
                not latest or now_ms() - cached["latest_at"] < settings.provider_fresh_seconds * 1000
            )
            recent_tail = (
                latest
                and cached["preceding"]
                and (len(cached["bars"]) >= count or cached["history_boundary"])
                and before - cached["preceding"][1] <= settings.provider_fresh_seconds * 1000
            )
            if (cached["satisfied"] or recent_tail) and fresh:
                page = {
                    **cached,
                    "series_kind": "provider",
                    "basis": meta["basis"],
                    "calendar": meta["calendar"],
                    "precision": meta["precision"],
                    "dataset_id": key,
                    "cache_hit": not fetched,
                    "indicators": [],
                }
                if on_ready:
                    on_ready(db, page)
                return page
        if latest and (len(cached["bars"]) >= count or cached["history_boundary"]) and (not fresh or not cached["interval"]):
            # Query only the missing tail since last observation, including an
            # overlapping bar for close/revision confirmation, never the whole window.
            if cached["bars"]:
                elapsed = max(0, now_ms() - cached["bars"][-1]["start"])
                amount = min(cap, max(3, elapsed // upstream.FRAME_MS[frame] + 3))
            else:
                amount = min(count, cap)
            cursor = before
        else:
            cursor = cached["interval"][0] if cached["interval"] else before
            missing = count - len(cached["bars"]) if cached["interval"] else count
            amount = min(cap, max(1, missing))
        fetch_page(key, meta, frame, cursor, amount, deadline,
                   kind=LANE.get() or "chart", latest=latest and cursor == before)
        fetched = True
    raise TimeoutError("平台分页未完成，请重试")


def _observed_read(meta, frame, count, operation):
    started = time.monotonic()
    timings = {}
    token = upstream.TIMINGS.set(timings)
    with _ACTIVE_LOCK:
        _ACTIVE_READS[meta["source"]] += 1
    try:
        result = operation()
        timings["read_total"] = (time.monotonic() - started) * 1000
        attempts = timings.pop("candles_attempts", [])
        return {**result, "candles_http_attempts": attempts,
                "timings_ms": {name: round(value, 2) for name, value in timings.items()}}
    except Exception as error:
        log.warning(
            "Provider read failed source=%s frame=%s count=%s type=%s status=%s elapsed_ms=%.2f timings_ms=%s",
            meta["source"], frame, count, type(error).__name__,
            getattr(getattr(error, "response", None), "status_code", None),
            (time.monotonic() - started) * 1000,
            {name: round(value, 2) if isinstance(value, (int, float)) else value
             for name, value in timings.items()},
        )
        raise
    finally:
        upstream.TIMINGS.reset(token)
        with _ACTIVE_LOCK:
            _ACTIVE_READS[meta["source"]] -= 1


def read(meta, frame, before, count, *, latest=False, deadline=None, on_ready=None):
    return _observed_read(meta, frame, count,
                          lambda: _read(meta, frame, before, count, latest=latest,
                                        deadline=deadline, on_ready=on_ready))


def _native_read(meta, body, before, count, prefix, latest, on_ready=None):
    """Discover demand using real bars and coverage; optional history is PG-only
    except for spare capacity in a mandatory upstream request.
    """
    if body.timeframe not in upstream.FRAMES:
        raise ValueError("无效平台周期")
    if count + prefix > CAPACITY:
        raise CapacityExceeded("原生历史必需数量及计算前缀超过20000根")
    if body.from_time is not None and body.from_time >= (body.before or before):
        raise ValueError("原生历史区间须满足from<to")
    from_time = body.from_time if body.from_time is not None and body.from_time < before else None
    deadline = DEADLINE.get() or time.monotonic() + settings.provider_request_seconds
    key = ensure(meta, body.timeframe)
    cap = 4000 if meta["source"] == "oanda" else 1000
    hot = None
    for _ in range(80):
        check_cancelled()
        if time.monotonic() >= deadline:
            raise TimeoutError("平台读取超过时间预算，请重试")
        # One bounded statement discovers the real range demand, prefix and E.
        # No metadata from another observation is attached to these bars.
        with snapshot_transaction(key, before, CAPACITY + 1,
                                  observation=body.history_observation,
                                  bounded_limit=CAPACITY + 1) as (db, state):
            bars = state["bars"]
            in_range = sum(b["chart_time"] >= from_time for b in bars) if from_time is not None else 0
            demand = max(count, in_range)
            if demand + prefix > CAPACITY:
                raise CapacityExceeded("原生历史必需数量及计算前缀超过20000根")
            connected = state["interval"]
            recent_tail = (latest and state["preceding"] and
                           before - state["preceding"][1] <= settings.provider_fresh_seconds * 1000)
            readable = connected or (state["preceding"] if recent_tail else None)
            range_done = from_time is None or bool(readable and readable[0] <= from_time)
            boundary = state["history_boundary"]
            mandatory_done = bool(readable and range_done and
                                  (len(bars) >= demand + prefix or boundary))
            fresh = not latest or now_ms() - state["latest_at"] < settings.provider_fresh_seconds * 1000
            if hot is None:
                hot = mandatory_done and fresh
            optional = optional_bars(
                body.native_history, demand, prefix, hot=hot,
                first=body.first_data_request, enabled=settings.provider_native_history_buffer,
                python=bool(body.indicators) or body.history_observation is not None,
                cold_extra=settings.provider_native_cold_extra_bars,
                first_extra=settings.provider_native_first_extra_bars,
                history_extra=settings.provider_native_history_extra_bars,
            )
            if mandatory_done and fresh:
                # Prefix is immediately before D. E never changes Python inputs.
                required = bars[-(demand + prefix):]
                visible = required[-demand:]
                if optional:
                    visible = bars[-min(len(bars), demand + optional):]
                boundary = boundary and len(visible) == len(bars)
                page = {
                    **state, "bars": required if body.indicators else visible,
                    "history_boundary": boundary, "has_more": not boundary,
                    "series_kind": "provider", "basis": meta["basis"],
                    "calendar": meta["calendar"], "precision": meta["precision"],
                    "dataset_id": key, "cache_hit": bool(hot), "indicators": [],
                    "mandatory_count": demand, "mandatory_read_count": demand + prefix,
                    "optional_count": len(visible) - min(demand, len(visible)),
                }
                if on_ready:
                    on_ready(db, page)
                return page
        tail = latest and bool(bars) and (not fresh or not connected)
        if tail:
            elapsed = max(0, now_ms() - bars[-1]["start"])
            amount = min(cap, max(3, elapsed // upstream.FRAME_MS[body.timeframe] + 3))
            cursor = before
            attached = 0
        else:
            cursor = connected[0] if connected else before
            missing = max(1, demand + prefix - (len(bars) if connected else 0))
            # Unknown range length is discovered with mandatory pages. When
            # count still needs a page, spare HTTP capacity may include E; it
            # never controls the next page's stopping condition.
            amount = min(cap, missing if range_done or missing > 1 else cap)
            attached = min(optional, max(0, cap - amount), max(0, CAPACITY - demand - prefix))
        fetch_page(key, meta, body.timeframe, cursor, amount, deadline,
                   kind=LANE.get() or "chart", latest=latest and cursor == before,
                   optional=attached)
    raise TimeoutError("平台分页未完成，请重试")


def native_read(meta, body, before, count, prefix, latest, on_ready=None):
    return _observed_read(meta, body.timeframe, count + prefix,
                          lambda: _native_read(meta, body, before, count, prefix, latest, on_ready))


def data(body):
    meta = upstream.metadata(body.instrument)
    now = (now_ms() // 1000 + 1) * 1000
    # Native to can include the chart's future right margin. It is exclusive;
    # never ask for/cache proof of future provider data.
    before = min(body.before or now, now)
    count = body.count_back or body.limit
    latest = body.before is None or body.first_data_request and body.before >= now - 120000
    extra = max((history_requirement(spec) for spec in body.indicators), default=0)
    native = body.native_history is not None
    if native:
        latest = body.before is None or before >= now - 120000

    def activate_ready(db, page):
        from .provider_service import activate
        try:
            # Reuse the completed snapshot's connection. A failed optional
            # write rolls back only its savepoint, not the ready response.
            with db.begin_nested():
                activate(body.client, page["dataset_id"], before,
                         page.get("mandatory_read_count", count + extra),
                         latest=latest, db=db)
        except Exception:
            log.warning("Provider optional activation failed source=%s frame=%s",
                        meta["source"], body.timeframe, exc_info=False)

    callback = activate_ready if body.client else None
    page = (native_read(meta, body, before, count, extra, latest, on_ready=callback) if native else
            read(meta, body.timeframe, before, count + extra, latest=latest, on_ready=callback))
    output_count = page.get("mandatory_count", count)
    visible = page["bars"] if native and not body.indicators else page["bars"][-output_count:]
    first = visible[0]["start"] if visible else before
    indicators = []
    for spec in body.indicators:
        result = calculate(page["bars"], spec)
        indicators.append(
            {
                **result,
                "id": spec.get("id", spec["name"]),
                "series": [
                    {**s, "values": [v for v in s["values"] if v["time"] >= first]}
                    for s in result["series"]
                ],
            }
        )
    return {
        k: v
        for k, v in {
            **page,
            "bars": visible,
            "indicators": indicators,
            "has_more": len(page["bars"]) > len(visible) or page["has_more"],
            "history_boundary": len(page["bars"]) <= len(visible) and page["history_boundary"],
        }.items()
        if k not in ("interval", "preceding", "satisfied")
    }
