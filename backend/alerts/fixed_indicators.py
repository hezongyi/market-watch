"""Full-origin indicator jobs over fixed period artifacts, with fenced publication.

Outputs/checkpoints are immutable. A newer input inherits only blocks ending
before the earliest changed dependency, then repairs every later value. Chart
requests enqueue work; they never scan all historical M1 or approximate warmup.
"""

import gzip
import hashlib
import json

from sqlalchemy import BigInteger, case, func, literal, select

from .calendar_profile import closures_from
from .chart_history_plan import bucket_has_trading
from .composite_series import period
from .domain import calendar_from
from .history_artifacts import read_artifact
from .indicator_state import ALGORITHM as ALGORITHM
from .indicator_state import ALGORITHMS, IndicatorState, presentation
from .observed_indicators import ALGORITHMS as OBSERVED_ALGORITHMS
from .observed_indicators import OBSERVED, STRICT, ObservedState, is_observed
from .source_history_store import _insert
from .storage import (
    CompositeMinuteInput,
    CompositeRevision,
    DisplaySnapshot,
    FixedIndicatorBlock,
    FixedIndicatorRun,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketDataset,
    RealtimeMapping,
    instant,
    now_ms,
    transaction,
    uid,
)

PAGE_SIZE = 2000


def coverage(rows):
    """Source-time half-open intervals; unknown rows never become null values."""
    ranges = []
    for row in sorted(rows, key=lambda row: row['start']):
        if ranges and ranges[-1]['end'] == row['start']:
            ranges[-1]['end'] = row['end']
        else:
            ranges.append({'start':row['start'], 'end':row['end']})
    return ranges


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _lineage_intervals(run, start, end):
    """Resolve immutable ancestry in SQL without loading every parent's state.

    Live appends can leave hundreds of ancestors even for a small viewport.
    Walking them through Session.get held the request's connection (and often
    the demand lock) for one round trip per ancestor, starving other API work.
    """
    ancestors = select(
        literal(run.id, type_=FixedIndicatorRun.id.type).label("id"),
        literal(run.parent_id, type_=FixedIndicatorRun.parent_id.type).label("parent_id"),
        literal(run.prefix_end, type_=BigInteger).label("prefix_end"),
        literal(end, type_=BigInteger).label("right"),
        literal(0).label("depth"),
    ).cte("indicator_ancestors", recursive=True)
    parent = FixedIndicatorRun.__table__
    inherited_end = case((ancestors.c.right < ancestors.c.prefix_end, ancestors.c.right),
                         else_=ancestors.c.prefix_end)
    ancestors = ancestors.union_all(select(
        parent.c.id, parent.c.parent_id, parent.c.prefix_end, inherited_end,
        ancestors.c.depth + 1,
    ).join(ancestors, parent.c.id == ancestors.c.parent_id).where(inherited_end > start))
    left = case((ancestors.c.prefix_end > start, ancestors.c.prefix_end), else_=start)
    return select(ancestors.c.id, left.label("left"), ancestors.c.right,
                  ancestors.c.depth).where(left < ancestors.c.right).cte("indicator_intervals")


def lineage(db, run, start, end):
    """Disjoint inherited intervals, with one round trip even after many appends."""
    if run and start < end:
        intervals = _lineage_intervals(run, start, end)
        for ident, left, right in db.execute(select(
                intervals.c.id, intervals.c.left, intervals.c.right).order_by(intervals.c.depth)):
            yield ident, left, right


def checkpoint_before(db, run, boundary):
    if not run or boundary <= -2**63:
        return None
    # Most appends resume from this run's own latest block. Keep that indexed
    # lookup fast; only resolve the full ancestry when the prefix is inherited.
    if run.prefix_end < boundary:
        block = db.execute(select(FixedIndicatorBlock.end, FixedIndicatorBlock.checkpoint)
            .where(FixedIndicatorBlock.run_id == run.id,
                   FixedIndicatorBlock.end <= boundary,
                   FixedIndicatorBlock.start >= max(-2**63, run.prefix_end))
            .order_by(FixedIndicatorBlock.end.desc()).limit(1)).first()
        if block:
            return tuple(block)
    if not run.parent_id:
        return None
    intervals = _lineage_intervals(run, -2**63, boundary)
    block = db.execute(select(FixedIndicatorBlock.end, FixedIndicatorBlock.checkpoint)
        .join(intervals, FixedIndicatorBlock.run_id == intervals.c.id)
        .where(FixedIndicatorBlock.end <= intervals.c.right,
               FixedIndicatorBlock.start >= intervals.c.left)
        .order_by(intervals.c.depth, FixedIndicatorBlock.end.desc()).limit(1)).first()
    return tuple(block) if block else None


def request(db, page, spec, *, stamp=None, input_policy=STRICT):
    if input_policy not in (STRICT, OBSERVED):
        raise ValueError("Unknown indicator input policy")
    stamp = now_ms() if stamp is None else stamp
    revision_id = page.get("revision_id")
    version_id = page.get("history_version_id", page.get("version_id"))
    version = db.get(HistoryVersion, version_id)
    revision = db.get(CompositeRevision, revision_id) if revision_id else None
    engine = (ObservedState(spec, source_start=version.start,
                           source_end=None if revision else version.end)
              if input_policy == OBSERVED else IndicatorState(spec))
    inst = db.get(Instrument, db.get(MarketDataset, version.dataset_id).instrument_id)
    phase = revision.rules["aggregation_calendar"] if revision else inst.calendar
    if phase == "source_date" and not revision:
        from .history_artifacts import published_artifact

        artifact = published_artifact(db, version.id, page["timeframe"])
        origin = artifact.manifest["blocks"][0]["start"]
    else:
        origin = period(version.start, page["timeframe"], phase)[0]
    value = page.get("input_revision", 0)
    target = version.end
    if revision:
        # A retained price credential owns its clock as well as its OHLC.
        # Crossing a period boundary must not confirm that snapshot's preview.
        calculation_stamp = stamp
        if input_policy == OBSERVED and page.get("display_snapshot_id"):
            calculation_stamp = db.get(DisplaySnapshot, page["display_snapshot_id"]).content["now"]
        latest = db.scalar(select(func.max(CompositeMinuteInput.start)).where(
            CompositeMinuteInput.revision_id == revision.id, CompositeMinuteInput.input_revision <= value))
        # No new job merely because the wall clock advances beyond fixed input.
        # Keep the clock boundary only while the last observed bucket is open.
        target = min(period(calculation_stamp, page["timeframe"], phase)[0],
                     period(max(revision.seam, latest if latest is not None else revision.seam), page["timeframe"], phase)[1])
    group = digest([version.id, revision_id, page["timeframe"], engine.spec, engine.algorithm])
    ident = digest([group, value, target])
    existing = db.get(FixedIndicatorRun, ident)
    if existing:
        return existing
    from .indicator_demands import MAX_PENDING_RUNS, DemandCapacity, guard
    guard(db)
    # Another reader may have created this shared run while we waited for the
    # capacity lock. Reuse it even when that insert consumed the final slot.
    existing = db.get(FixedIndicatorRun, ident)
    if existing:
        return existing
    if db.scalar(select(func.count()).select_from(FixedIndicatorRun).where(FixedIndicatorRun.status=='pending'))>=MAX_PENDING_RUNS:
        raise DemandCapacity()
    # Match the artifact reader's shared lock: upgrading two concurrent readers
    # to exclusive locks would deadlock. Immutable inputs plus unique run IDs
    # make concurrent selection safe; reclamation takes the exclusive lock.
    db.scalar(select(MarketDataset.id).where(MarketDataset.id == version.dataset_id).with_for_update(read=True))
    if db.get(HistoryReclamation, version.id):
        raise ValueError("历史版本价格数据已回收，不能创建指标任务")
    parent, prefix, state = None, origin, engine.checkpoint()
    candidates = db.scalars(select(FixedIndicatorRun).where(FixedIndicatorRun.group_key == group,
        FixedIndicatorRun.input_revision <= value, FixedIndicatorRun.cursor > origin)
        .order_by(FixedIndicatorRun.input_revision.desc(), FixedIndicatorRun.cursor.desc()).limit(32))
    for candidate in candidates:
        boundary = target
        if revision:
            changed = db.scalar(select(func.min(CompositeMinuteInput.start)).where(
                CompositeMinuteInput.revision_id == revision.id,
                CompositeMinuteInput.input_revision > candidate.input_revision,
                CompositeMinuteInput.input_revision <= value))
            if changed is not None:
                boundary = min(boundary, period(changed, page["timeframe"], phase)[0])
        inherited = checkpoint_before(db, candidate, boundary)
        if inherited:
            prefix, state = inherited
            parent = candidate.id
            break
    db.execute(_insert(db)(FixedIndicatorRun).values(id=ident, group_key=group,
        history_version_id=version.id, revision_id=revision_id, timeframe=page["timeframe"],
        spec=engine.spec, algorithm=engine.algorithm, input_revision=value, target_end=target,
        parent_id=parent, prefix_end=prefix, cursor=prefix, state=state, status="pending",
        lease_until=0, next_at=0, attempts=0, updated_at=stamp)
        .on_conflict_do_nothing(index_elements=["id"]))
    from .publication_wakeup import notify

    notify(db)
    return db.get(FixedIndicatorRun, ident)


def _context(db, run):
    version = db.get(HistoryVersion, run.history_version_id)
    revision = db.get(CompositeRevision, run.revision_id) if run.revision_id else None
    inst = db.get(Instrument, db.get(MarketDataset, version.dataset_id).instrument_id)
    phase = revision.rules["aggregation_calendar"] if revision else inst.calendar
    profiles = [(version.start, revision.seam if revision else version.end,
                 version.manifest.get("calendar_profile", {}))]
    if revision:
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        target = db.get(Instrument, db.get(MarketDataset, mapping.target_dataset_id).instrument_id)
        profiles.append((revision.seam, run.target_end, target.calendar_profile))
    return version, revision, phase, profiles


def gap_before(previous_end, start, phase, profiles):
    if phase == "source_date":
        # Supplier observations exclude weekends/halts; elapsed calendar days
        # do not establish a missing trading bar or reset a fixed indicator.
        return False
    if previous_end is None or start <= previous_end:
        return False
    for left, right, profile in profiles:
        a, b = max(left, previous_end), min(right, start)
        if a < b and bucket_has_trading(instant(a), instant(b), calendar_from(phase, profile, explicit=True),
                                      False, closures_from(profile)):
            return True
    return False


def input_rows(db, run, *, limit=None):
    """Forward indexed artifacts only; wait for complete composite waterline."""
    from .composite_aggregates import read

    limit = PAGE_SIZE if limit is None else limit
    version, revision, phase, profiles = _context(db, run)
    if revision:
        from .live_window import require_window

        require_window(revision.seam)
    seam_bucket = period(revision.seam, run.timeframe, phase)[0] if revision else run.target_end
    rows = []
    if run.cursor < min(seam_bucket, run.target_end):
        rows = read_artifact(db, version.id, run.timeframe, start=run.cursor,
            end=min(seam_bucket, run.target_end), limit=limit)
    if revision and len(rows) < limit and run.target_end > seam_bucket:
        tail = read(db, revision.id, run.timeframe, run.input_revision, after=max(run.cursor, seam_bucket),
            before=run.target_end, count=limit - len(rows), now=run.target_end, newest_first=False)
        if tail is None:
            return None
        rows += tail
    return rows, phase, profiles


def claim(run_id=None, *, alert_priority=False):
    if alert_priority and not run_id:
        raise ValueError("Realtime indicators require an exact active dependency")
    with transaction() as db:
        from .runtime_health import assert_current

        assert_current(db)
        stamp = now_ms()
        query = select(FixedIndicatorRun).where(FixedIndicatorRun.status == "pending", FixedIndicatorRun.algorithm.in_((*ALGORITHMS, *OBSERVED_ALGORITHMS)),
            FixedIndicatorRun.lease_until <= stamp, FixedIndicatorRun.next_at <= stamp)
        if run_id:
            query = query.where(FixedIndicatorRun.id == run_id)
        if alert_priority:
            # Only a ready checkpoint's small live suffix may bypass display
            # warmup capacity. History initialization/long repair stays in data.
            order = FixedIndicatorRun.updated_at
        else:
            from .indicator_demands import priority, warmup_capacity

            order = priority(db, FixedIndicatorRun.id, stamp, kind="fixed")
            query = query.where(warmup_capacity(FixedIndicatorRun, FixedIndicatorRun.id, stamp))
        run = db.scalar(query.order_by(order, FixedIndicatorRun.updated_at, FixedIndicatorRun.id)
            .with_for_update(skip_locked=True).limit(1))
        if not run:
            return None
        if alert_priority and not realtime_suffix_ready(db, run):
            return None
        run.lease_token, run.lease_until, run.updated_at = uid(), stamp + 60000, stamp
        return {"id": run.id, "token": run.lease_token, "cursor": run.cursor}


def build(ownership):
    with transaction() as db:
        run = db.get(FixedIndicatorRun, ownership["id"])
        inputs = input_rows(db, run)
        if inputs is None:
            return None
        rows, phase, profiles = inputs
        seam = db.get(CompositeRevision, run.revision_id).seam if run.revision_id else None
        calculated = calculate_inputs(run, rows, phase, profiles, seam=seam)
        cursor = rows[-1]["end"] if rows else run.target_end
        done = len(rows) < PAGE_SIZE or cursor >= run.target_end
        return {**calculated, "cursor": run.target_end if done else cursor, "done": done}


def calculate_inputs(run, rows, phase, profiles, *, seam=None, initial_state=None, batch=False):
    """One exact numerical path for worker pages and bounded foreground replay."""
    if is_observed(run):
        from .observed_indicators import calculate

        return calculate(run, rows, phase, profiles, seam=seam, initial_state=initial_state)
    if batch and run.spec["name"] in ("SMA", "EMA", "LWMA", "BBANDS", "RSI", "ATR", "MACD", "STOCH"):
        from .chart_indicators import calculate
        from .indicator_state import advance_dependencies

        if initial_state and initial_state.get('state'):
            raise ValueError('Batch oracle requires a full origin replay, not a checkpoint suffix')
        engine = IndicatorState(run.spec)
        prepared, output = [], []
        for source in rows:
            previous_end = engine.state.get("last_end")
            row = {**source, "gap_before": gap_before(previous_end, source["start"], phase, profiles)}
            if seam is not None and not row["gap_before"] and previous_end is not None and previous_end <= seam <= row["start"]:
                row["seam_at_start"] = True
            advance_dependencies(engine.state, engine.name, engine.params, row)
            prepared.append(row)
            output.append({"start": row["start"], "end": row["end"],
                **({"break_before": True} if row["gap_before"] else {}),
                "dependency_origin": engine.state.get("origin"), "seam_dependency": engine.state.get("seam", False)})
        oracle = calculate(prepared, run.spec)
        for index, row in enumerate(output):
            row["values"] = {series["key"]: series["values"][index]["value"] for series in oracle["series"]}
            row["initialized"] = all(value is not None for value in row["values"].values())
        # No checkpoint is invented from a batch result. Durable worker replay
        # still owns its existing, versioned state format and page publication.
        return {"rows": output, "state": None, "display": None}
    engine = IndicatorState(run.spec, run.state if initial_state is None else initial_state)
    output = []
    for source in rows:
        row = {**source, "indicator_calendar": phase, "indicator_timeframe": run.timeframe}
        if run.spec["name"] in ("SWING_SR_V1", "ROLLING_RANGE_SQUEEZE", "NR4_NR7_BREAKOUT_V1"):
            from .series_access import fixed_label

            row["chart_time"] = fixed_label(row, run.timeframe, phase)
        row["gap_before"] = gap_before(engine.state.get("last_end"), row["start"], phase, profiles)
        previous_end = engine.state.get("last_end")
        if (seam is not None and not row["gap_before"] and previous_end is not None
                and previous_end <= seam <= row["start"]):
            # The seam may lie in an evidenced closure without a candle at T.
            row["seam_at_start"] = True
        values = engine.step(row)
        output.append({"start": row["start"], "end": row["end"], "values": values,
            **({"break_before": True} if row["gap_before"] else {}),
            "dependency_origin": engine.state.get("origin"), "seam_dependency": engine.state.get("seam", False),
            "initialized": engine.initialized(values)})
    return {"rows": output, "state": engine.checkpoint(), "display": getattr(engine, "last_presentation", None)}


def _lock(db, ownership):
    run = db.scalar(select(FixedIndicatorRun).where(FixedIndicatorRun.id == ownership["id"]).with_for_update())
    if (not run or run.lease_token != ownership["token"] or run.lease_until <= now_ms()
            or run.cursor != ownership["cursor"] or run.status != "pending"):
        raise TimeoutError("Fixed indicator ownership expired or superseded")
    return run


def commit(ownership, result):
    with transaction() as db:
        from .runtime_health import assert_current

        assert_current(db)
        run = _lock(db, ownership)
        if result is None:
            run.next_at = now_ms() + 1000
        else:
            if result["rows"]:
                rows = result["rows"]
                raw = json.dumps(rows, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
                db.add(FixedIndicatorBlock(run_id=run.id, start=rows[0]["start"], end=rows[-1]["end"],
                    checkpoint=result["state"], checksum=hashlib.sha256(raw).hexdigest(), content=gzip.compress(raw, mtime=0)))
            run.state, run.cursor = result["state"], result["cursor"]
            run.status = "complete" if result["done"] else "pending"
            run.next_at, run.error, run.attempts = 0, None, 0
        run.lease_token, run.lease_until, run.updated_at = None, 0, now_ms()


def indicator_tick(run_id=None, *, alert_priority=False, raise_errors=False):
    owner = claim(run_id, alert_priority=alert_priority)
    if not owner:
        return False
    try:
        commit(owner, build(owner))
    except Exception as error:
        with transaction() as db:
            from .runtime_health import assert_current

            assert_current(db)
            try:
                run = _lock(db, owner)
            except TimeoutError:
                if raise_errors:
                    raise error
                return True
            run.attempts += 1
            run.error, run.next_at = type(error).__name__, now_ms() + min(60000, 1000 * 2 ** min(run.attempts, 6))
            run.lease_token, run.lease_until, run.updated_at = None, 0, now_ms()
        if raise_errors:
            raise
    return True


def outputs(db, run, start, end):
    if not run or start >= end:
        return []
    rows = []
    intervals = _lineage_intervals(run, start, end)
    blocks = db.execute(select(FixedIndicatorBlock.content, FixedIndicatorBlock.checksum,
        intervals.c.left, intervals.c.right)
        .join(intervals, FixedIndicatorBlock.run_id == intervals.c.id)
        .where(FixedIndicatorBlock.start < intervals.c.right,
               FixedIndicatorBlock.end > intervals.c.left))
    for content, checksum, left, right in blocks:
        raw = gzip.decompress(content)
        if hashlib.sha256(raw).hexdigest() != checksum:
            raise ValueError("Fixed indicator output checksum mismatch")
        rows += [row for row in json.loads(raw) if left <= row["start"] < right]
    return sorted(rows, key=lambda row: row["start"])


def realtime_suffix_ready(db, run):
    """Admit at most eight live bars after an initialized durable checkpoint."""
    from .composite_chart import SPAN

    state = run.state.get("state") or {}
    if (run.status != "pending" or not run.revision_id or not state
            or state.get("last_end") != run.cursor
            or not 0 <= run.target_end - run.cursor <= 8 * SPAN[run.timeframe]):
        return False
    previous = outputs(db, run, run.cursor - SPAN[run.timeframe], run.cursor)
    if not previous or not previous[-1].get("initialized"):
        return False
    inputs = input_rows(db, run, limit=9)
    if inputs is None:
        return False
    rows, _, _ = inputs
    return len(rows) <= 8 and (not rows or rows[-1]["end"] >= run.target_end)


def alert_append(db, run):
    """Read-only short suffix from a verified checkpoint; never publish it.

    Initialization and long repairs remain owned by the durable worker. Both
    readers use the same fixed revision, gap checks and numerical calculation.
    """
    from .composite_chart import SPAN

    if (run.status != "pending" or not run.revision_id or not run.parent_id or run.error
            or not run.state.get("state")
            or not 0 <= run.target_end - run.cursor <= 8 * SPAN[run.timeframe]):
        return None
    inputs = input_rows(db, run)
    if inputs is None:
        return None
    rows, phase, profiles = inputs
    if len(rows) > 8 or rows and rows[-1]["end"] < run.target_end:
        return None
    revision = db.get(CompositeRevision, run.revision_id)
    return calculate_inputs(run, rows, phase, profiles, seam=revision.seam)


def chart_results(db, page, specs, *, provisional=False, stamp=None, purpose='display', display_retry=None, client=None, consumers=(), foreground=False, input_policy=STRICT):
    results, progress, display_errors, restarted = [], [], [], {}
    replay_pages = {}
    if not page["bars"]:
        return results, progress
    artifact_rows = None
    if not page.get('revision_id'):
        from .history_artifacts import published_artifact

        artifact_rows = published_artifact(db, page.get('history_version_id', page.get('version_id')),
                                           page['timeframe']).count
    for spec in specs:
        if input_policy != STRICT and purpose != 'display':
            raise ValueError("Observed inputs are only available for chart display")
        run = request(db, page, spec, stamp=stamp, input_policy=input_policy)
        start, end = page["bars"][0]["start"], page["bars"][-1]["end"]
        from .indicator_demands import renew
        renew(db,client,consumers,run,snapshot_id=page.get('display_snapshot_id'),
            start=start,end=end,stamp=stamp or now_ms())
        if is_observed(run):
            from .observed_indicators import chart_result

            result, status = chart_result(db, page, spec, run, provisional=provisional,
                                          stamp=stamp or now_ms(), replay_pages=replay_pages)
            results.append(result)
            progress.append(status)
            continue
        rows = outputs(db, run, start, min(end, run.cursor))
        status = {"id": spec.get("id", spec["name"]), "run_id": run.id, "status": run.status,
            "cursor": run.cursor, "target_end": run.target_end, "input_revision": run.input_revision,
            "algorithm": run.algorithm, "error": run.error, "next_at": run.next_at,
            "parent_run_id": run.parent_id, "reused_prefix_end": run.prefix_end}
        decision_state = run.state
        appended = alert_append(db, run) if purpose == "alert" and provisional else None
        if appended is not None:
            rows += [row for row in appended["rows"] if start <= row["start"] < end]
            decision_state = appended["state"]
            status["execution"] = {"path": "alert-checkpoint-suffix",
                                   "calculation_steps": len(appended["rows"])}
        if artifact_rows is not None:
            status['execution'] = {'path': 'durable-fixed', 'input_rows': artifact_rows,
                'result_cache': 'hit' if run.status == 'complete' else
                    'checkpoint' if run.cursor > page['origin'] or run.parent_id else 'miss',
                'calculation_steps': 0}
        display = None
        if run.spec["name"] in ("SWING_SR_V1", "ROLLING_RANGE_SQUEEZE"):
            from .rolling_range_squeeze import SqueezeState
            from .swing_sr import SwingState

            display_engine = SqueezeState if run.spec["name"] == "ROLLING_RANGE_SQUEEZE" else SwingState
            display = display_engine(run.spec["params"], run.state["state"] or None).presentation()
            display["history_complete"] = run.status == "complete"
            display["history_revision"] = run.id
        tail = page["bars"]
        if (display is not None and run.status == "complete" and provisional
                and end <= run.target_end and run.revision_id):
            # Ordinary left pagination retains the live display cutoff. This is
            # a bounded read of the current bucket, never another history scan.
            from .composite_chart import chart_page

            latest = chart_page(db, page["composite_id"], run.timeframe, count=1,
                                revision_id=run.revision_id, provisional=True, now=stamp,
                                display_snapshot=(db.get(DisplaySnapshot,
                                    page['display_snapshot_id']) if page.get('display_snapshot_id') else None))
            if latest["input_revision"] == run.input_revision:
                tail = latest["bars"]
        from .fixed_indicator_display import confirmed_page

        # The request's post-transaction foreground replay already owns this
        # confirmed prefix. Do not first rescan it or create a redundant display
        # task; over-budget prefixes continue through the durable fixed worker.
        confirmed_foreground = (foreground and tail is page['bars'] and end <= run.target_end
                                and confirmed_page(db, page))
        repaired = None
        if provisional and purpose == 'display' and run.revision_id and not confirmed_foreground:
            from .display_indicators import suffix

            display_page = page if tail is page['bars'] else {**page, 'bars': sorted(
                {bar['start']: bar for bar in [*page['bars'], *tail]}.values(), key=lambda bar: bar['start'])}
            try:
                repaired = suffix(db, run, display_page, stamp=stamp or now_ms(), retry=display_retry)
            except ValueError as error:
                if not hasattr(error, 'display_retry'):
                    raise
                display_errors.append(error)
                continue
            if repaired:
                restarted.update(repaired.get('restarted') or {})
                status['display_status'] = 'pending' if repaired['pending'] else 'complete'
                status['affected_start'] = repaired['affected']
                if not repaired['pending']:
                    rows = [row for row in rows if row['start'] < repaired['affected']]
                    rows += [row for row in repaired['rows'] if start <= row['start'] < end]
                    display = repaired['display'] or display
        elif (run.status == "complete" or appended is not None) and provisional and (end > run.target_end or tail is not page["bars"]):
            _, _, phase, profiles = _context(db, run)
            engine = IndicatorState(run.spec, decision_state)
            for bar in tail:
                if bar["start"] < run.target_end:
                    continue
                if bar["start"] >= period(stamp or now_ms(), run.timeframe, phase)[1]:
                    break
                if rows and bar["start"] <= rows[-1]["start"]:
                    raise ValueError("Indicator tail overlaps fixed output")
                row = {**bar, "indicator_calendar": phase, "indicator_timeframe": run.timeframe,
                       "gap_before": gap_before(engine.state.get("last_end"), bar["start"], phase, profiles)}
                if display is not None or run.spec["name"] == "NR4_NR7_BREAKOUT_V1":
                    from .series_access import fixed_label

                    row["chart_time"] = fixed_label(row, run.timeframe, phase)
                values = engine.step(row, provisional=True)
                if display is not None:
                    display = engine.last_presentation | {
                        "history_complete": True, "history_revision": run.id}
                trial = IndicatorState(run.spec, decision_state)
                trial.step({**row, "complete": True})
                if start <= bar["start"] < end:
                    rows.append({"start": bar["start"], "values": values, "provisional": True,
                        **({"break_before": True} if row["gap_before"] else {}),
                        "dependency_origin": trial.state.get("origin"), "seam_dependency": trial.state.get("seam", False),
                        "initialized": trial.initialized(values)})
                    if appended is not None:
                        status["provisional_ready"] = trial.initialized(values)
                break
        result = presentation(spec, rows, display)
        available = {row['start'] for row in rows}
        visible_complete = all(bar['start'] in available for bar in page['bars'])
        bar_ends = {bar['start']:bar['end'] for bar in page['bars']}
        status.update(status=run.status if run.status=='complete' or run.cursor<=page['origin'] else 'partial',
            calculation_origin=page['origin'], producer='backend', accuracy='oracle_equivalent',
            canonical_verified=True, coverage=coverage([{**row,'end':bar_ends[row['start']]} for row in rows if row['start'] in bar_ends]), required_coverage=coverage(page['bars']),
            visible_complete=visible_complete,
            input_evidence={'revision_id':run.revision_id,'input_revision':run.input_revision,
                'history_version_id':run.history_version_id,'display_snapshot_id':page.get('display_snapshot_id')},
            display_task_ids=[repaired['task_id']] if provisional and purpose=='display' and run.revision_id and repaired and repaired.get('task_id') else [])
        results.append({**result, "id": status["id"], "calculation": status,
                        "dependencies": [{key: row.get(key) for key in
                            ("start", "dependency_origin", "seam_dependency", "initialized", "provisional")} for row in rows]})
        progress.append(status)
    if display_errors:
        error = display_errors[0]
        error.display_retry = restarted | {key: value for fault in display_errors for key, value in fault.display_retry.items()}
        raise error
    return results, progress
