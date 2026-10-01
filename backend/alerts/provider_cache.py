"""Persistent native-period range reads behind the chart API.

All provider I/O happens outside a database transaction. A dataset lease serializes
overlapping observations across processes; its generation fences expired owners.
"""

import hashlib
import json
import logging
import threading
import time
from contextvars import ContextVar

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from . import provider_chart as upstream
from .chart_indicators import calculate, history_requirement
from .config import settings
from .market_resources import LANE, lane
from .storage import ProviderBar, ProviderDataset, now_ms, transaction, uid

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_READS = {"oanda": 0, "binance": 0}
CANCELLED = ContextVar("provider_request_cancelled", default=None)
DEADLINE = ContextVar("provider_request_deadline", default=None)
log = logging.getLogger(__name__)


def check_cancelled():
    event = CANCELLED.get()
    if event is not None and event.is_set():
        raise TimeoutError("平台读取已取消")


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
    with transaction() as db:
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


def snapshot(key, before, count):
    with transaction() as db:
        dataset = db.get(ProviderDataset, key)
        dataset.accessed_at = now_ms()
        ranges = dataset.coverage
        interval = next((r for r in ranges if r[0] < before <= r[1]), None)
        preceding = next((r for r in reversed(ranges) if r[1] < before), None)
        readable = interval or preceding
        rows = []
        if readable:
            rows = list(
                db.scalars(
                    select(ProviderBar)
                    .where(
                        ProviderBar.dataset_id == key,
                        ProviderBar.chart_time >= readable[0],
                        ProviderBar.chart_time < before,
                    )
                    .order_by(ProviderBar.chart_time.desc())
                    .limit(count + 1)
                )
            )[::-1]
        boundary = bool(readable and dataset.earliest and readable[0] == 0 and len(rows) <= count)
        return {
            "bars": [r.payload for r in rows[-count:]],
            "history_boundary": boundary,
            "has_more": not boundary,
            "as_of": dataset.updated_at,
            "latest_at": dataset.latest_at,
            "cache_revision": dataset.revision,
            "interval": interval,
            "preceding": preceding,
            "satisfied": bool(interval and (len(rows) >= count or boundary)),
        }


def claim(key):
    with transaction() as db:
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
    with transaction() as db:
        row = db.scalar(select(ProviderDataset).where(ProviderDataset.id == key).with_for_update())
        if row and (row.lease_token, row.generation) == lease:
            row.lease_token = None
            row.lease_until = 0


def commit_page(key, lease, page, before, observed_at, *, latest=False):
    """Commit bars and only the range proven by this successful count/to page."""
    rows = page["bars"]
    boundary = page["history_boundary"]
    start = rows[0]["chart_time"] if rows else before
    if boundary:
        start = 0
    changed = []
    with transaction() as db:
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


def fetch_page(key, meta, frame, before, count, deadline, *, kind="chart", latest=False):
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
            page = upstream.native_page(meta, frame, before, count, deadline=deadline)
        commit_started = time.monotonic()
        commit_page(key, lease, page, before, observed_at, latest=latest)
        upstream.record_timing("database_commit", commit_started)
        return page
    finally:
        release(key, lease)


def _read(meta, frame, before, count, *, latest=False, deadline=None):
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
        cached = snapshot(key, before, count)
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
            return {
                **cached,
                "series_kind": "provider",
                "basis": meta["basis"],
                "calendar": meta["calendar"],
                "precision": meta["precision"],
                "dataset_id": key,
                "cache_hit": not fetched,
                "indicators": [],
            }
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


def read(meta, frame, before, count, *, latest=False, deadline=None):
    started = time.monotonic()
    timings = {}
    token = upstream.TIMINGS.set(timings)
    with _ACTIVE_LOCK:
        _ACTIVE_READS[meta["source"]] += 1
    try:
        result = _read(meta, frame, before, count, latest=latest, deadline=deadline)
        timings["read_total"] = (time.monotonic() - started) * 1000
        return {**result, "timings_ms": {name: round(value, 2) for name, value in timings.items()}}
    except Exception as error:
        log.warning(
            "Provider read failed source=%s frame=%s count=%s type=%s status=%s elapsed_ms=%.2f timings_ms=%s",
            meta["source"], frame, count, type(error).__name__,
            getattr(getattr(error, "response", None), "status_code", None),
            (time.monotonic() - started) * 1000,
            {name: round(value, 2) for name, value in timings.items()},
        )
        raise
    finally:
        upstream.TIMINGS.reset(token)
        with _ACTIVE_LOCK:
            _ACTIVE_READS[meta["source"]] -= 1


def data(body):
    meta = upstream.metadata(body.instrument)
    now = (now_ms() // 1000 + 1) * 1000
    # Native to can include the chart's future right margin. It is exclusive;
    # never ask for/cache proof of future provider data.
    before = min(body.before or now, now)
    count = body.count_back or body.limit
    latest = body.before is None or body.first_data_request and body.before >= now - 120000
    extra = max((history_requirement(spec) for spec in body.indicators), default=0)
    page = read(meta, body.timeframe, before, count + extra, latest=latest)
    if body.client:
        from .provider_service import activate

        activate(body.client, page["dataset_id"], before, count + extra, latest=latest)
    visible = page["bars"][-count:]
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
            "has_more": len(page["bars"]) > count or page["has_more"],
            "history_boundary": len(page["bars"]) <= count and page["history_boundary"],
        }.items()
        if k not in ("interval", "preceding", "satisfied")
    }
