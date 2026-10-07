"""Full-origin indicator jobs over fixed period artifacts, with fenced publication.

Outputs/checkpoints are immutable. A newer input inherits only blocks ending
before the earliest changed dependency, then repairs every later value. Chart
requests enqueue work; they never scan all historical M1 or approximate warmup.
"""

import gzip
import hashlib
import json

from sqlalchemy import func, select

from .calendar_profile import closures_from
from .chart_history_plan import bucket_has_trading
from .composite_series import period
from .domain import calendar_from
from .history_artifacts import read_artifact
from .indicator_state import ALGORITHM, IndicatorState, presentation
from .source_history_store import _insert
from .storage import (
    CompositeMinuteInput,
    CompositeRevision,
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


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def lineage(db, run, start, end):
    """Disjoint inherited intervals, iterative even after thousands of appends."""
    while run and start < end:
        left = max(start, run.prefix_end)
        if left < end:
            yield run.id, left, end
        end = min(end, run.prefix_end)
        run = db.get(FixedIndicatorRun, run.parent_id) if run.parent_id and start < end else None


def checkpoint_before(db, run, boundary):
    for ident, left, right in lineage(db, run, -2**63, boundary):
        block = db.scalar(select(FixedIndicatorBlock).where(FixedIndicatorBlock.run_id == ident,
            FixedIndicatorBlock.end <= right, FixedIndicatorBlock.start >= left)
            .order_by(FixedIndicatorBlock.end.desc()).limit(1))
        if block:
            return block.end, block.checkpoint
    return None


def request(db, page, spec, *, stamp=None):
    engine = IndicatorState(spec)
    stamp = now_ms() if stamp is None else stamp
    revision_id = page.get("revision_id")
    version_id = page.get("history_version_id", page.get("version_id"))
    version = db.get(HistoryVersion, version_id)
    revision = db.get(CompositeRevision, revision_id) if revision_id else None
    inst = db.get(Instrument, db.get(MarketDataset, version.dataset_id).instrument_id)
    phase = revision.rules["aggregation_calendar"] if revision else inst.calendar
    origin = period(version.start, page["timeframe"], phase)[0]
    value = page.get("input_revision", 0)
    target = version.end
    if revision:
        latest = db.scalar(select(func.max(CompositeMinuteInput.start)).where(
            CompositeMinuteInput.revision_id == revision.id, CompositeMinuteInput.input_revision <= value))
        # No new job merely because the wall clock advances beyond fixed input.
        # Keep the clock boundary only while the last observed bucket is open.
        target = min(period(stamp, page["timeframe"], phase)[0],
                     period(max(revision.seam, latest if latest is not None else revision.seam), page["timeframe"], phase)[1])
    group = digest([version.id, revision_id, page["timeframe"], engine.spec, ALGORITHM])
    ident = digest([group, value, target])
    existing = db.get(FixedIndicatorRun, ident)
    if existing:
        return existing
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
        spec=engine.spec, algorithm=ALGORITHM, input_revision=value, target_end=target,
        parent_id=parent, prefix_end=prefix, cursor=prefix, state=state, status="pending",
        lease_until=0, next_at=0, attempts=0, updated_at=stamp)
        .on_conflict_do_nothing(index_elements=["id"]))
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
    if previous_end is None or start <= previous_end:
        return False
    for left, right, profile in profiles:
        a, b = max(left, previous_end), min(right, start)
        if a < b and bucket_has_trading(instant(a), instant(b), calendar_from(phase, profile, explicit=True),
                                      False, closures_from(profile)):
            return True
    return False


def input_rows(db, run):
    """Forward indexed artifacts only; wait for complete composite waterline."""
    from .composite_aggregates import read

    version, revision, phase, profiles = _context(db, run)
    seam_bucket = period(revision.seam, run.timeframe, phase)[0] if revision else run.target_end
    rows = []
    if run.cursor < min(seam_bucket, run.target_end):
        rows = read_artifact(db, version.id, run.timeframe, start=run.cursor,
            end=min(seam_bucket, run.target_end), limit=PAGE_SIZE)
    if revision and len(rows) < PAGE_SIZE and run.target_end > seam_bucket:
        tail = read(db, revision.id, run.timeframe, run.input_revision, after=max(run.cursor, seam_bucket),
            before=run.target_end, count=PAGE_SIZE - len(rows), now=run.target_end, newest_first=False)
        if tail is None:
            return None
        rows += tail
    return rows, phase, profiles


def claim(run_id=None):
    with transaction() as db:
        stamp = now_ms()
        query = select(FixedIndicatorRun).where(FixedIndicatorRun.status == "pending", FixedIndicatorRun.algorithm == ALGORITHM,
            FixedIndicatorRun.lease_until <= stamp, FixedIndicatorRun.next_at <= stamp)
        if run_id:
            query = query.where(FixedIndicatorRun.id == run_id)
        run = db.scalar(query.order_by(FixedIndicatorRun.updated_at, FixedIndicatorRun.id)
            .with_for_update(skip_locked=True).limit(1))
        if not run:
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
        engine = IndicatorState(run.spec, run.state)
        seam = db.get(CompositeRevision, run.revision_id).seam if run.revision_id else None
        output = []
        for source in rows:
            row = dict(source)
            row["gap_before"] = gap_before(engine.state.get("last_end"), row["start"], phase, profiles)
            previous_end = engine.state.get("last_end")
            if (seam is not None and not row["gap_before"] and previous_end is not None
                    and previous_end <= seam <= row["start"]):
                # The seam can lie in an evidenced closure with no candle at T.
                # A dependency still spans sources even without seam_at_start.
                row["seam_at_start"] = True
            values = engine.step(row)
            output.append({"start": row["start"], "end": row["end"], "values": values,
                "dependency_origin": engine.state.get("origin"), "seam_dependency": engine.state.get("seam", False),
                "initialized": all(value is not None for value in values.values())})
        cursor = rows[-1]["end"] if rows else run.target_end
        done = len(rows) < PAGE_SIZE or cursor >= run.target_end
        return {"rows": output, "state": engine.checkpoint(), "cursor": run.target_end if done else cursor, "done": done}


def _lock(db, ownership):
    run = db.scalar(select(FixedIndicatorRun).where(FixedIndicatorRun.id == ownership["id"]).with_for_update())
    if (not run or run.lease_token != ownership["token"] or run.lease_until <= now_ms()
            or run.cursor != ownership["cursor"] or run.status != "pending"):
        raise TimeoutError("Fixed indicator ownership expired or superseded")
    return run


def commit(ownership, result):
    with transaction() as db:
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


def indicator_tick(run_id=None):
    owner = claim(run_id)
    if not owner:
        return False
    try:
        commit(owner, build(owner))
    except Exception as error:
        with transaction() as db:
            try:
                run = _lock(db, owner)
            except TimeoutError:
                return True
            run.attempts += 1
            run.error, run.next_at = type(error).__name__, now_ms() + min(60000, 1000 * 2 ** min(run.attempts, 6))
            run.lease_token, run.lease_until, run.updated_at = None, 0, now_ms()
    return True


def outputs(db, run, start, end):
    rows = []
    for ident, left, right in lineage(db, run, start, end):
        for block in db.scalars(select(FixedIndicatorBlock).where(FixedIndicatorBlock.run_id == ident,
            FixedIndicatorBlock.start < right, FixedIndicatorBlock.end > left).order_by(FixedIndicatorBlock.start)):
            raw = gzip.decompress(block.content)
            if hashlib.sha256(raw).hexdigest() != block.checksum:
                raise ValueError("Fixed indicator output checksum mismatch")
            rows += [row for row in json.loads(raw) if left <= row["start"] < right]
    return sorted(rows, key=lambda row: row["start"])


def chart_results(db, page, specs, *, provisional=False, stamp=None):
    results, progress = [], []
    if not page["bars"]:
        return results, progress
    for spec in specs:
        run = request(db, page, spec, stamp=stamp)
        start, end = page["bars"][0]["start"], page["bars"][-1]["end"]
        rows = outputs(db, run, start, min(end, run.cursor))
        status = {"id": spec.get("id", spec["name"]), "run_id": run.id, "status": run.status,
            "cursor": run.cursor, "target_end": run.target_end, "input_revision": run.input_revision,
            "algorithm": run.algorithm, "error": run.error, "next_at": run.next_at,
            "parent_run_id": run.parent_id, "reused_prefix_end": run.prefix_end}
        if run.status == "complete" and provisional and end > run.target_end:
            _, _, phase, profiles = _context(db, run)
            engine = IndicatorState(run.spec, run.state)
            for bar in page["bars"]:
                if bar["start"] < run.target_end:
                    continue
                if bar["start"] >= period(stamp or now_ms(), run.timeframe, phase)[1]:
                    break
                if rows and bar["start"] <= rows[-1]["start"]:
                    raise ValueError("Indicator tail overlaps fixed output")
                row = {**bar, "gap_before": gap_before(engine.state.get("last_end"), bar["start"], phase, profiles)}
                values = engine.step(row, provisional=True)
                trial = IndicatorState(run.spec, run.state)
                trial.step({**row, "complete": True})
                rows.append({"start": bar["start"], "values": values, "provisional": True,
                    "dependency_origin": trial.state.get("origin"), "seam_dependency": trial.state.get("seam", False),
                    "initialized": all(value is not None for value in values.values())})
                break
        result = presentation(spec, rows)
        results.append({**result, "id": status["id"], "calculation": status,
                        "dependencies": [{key: row.get(key) for key in
                            ("start", "dependency_origin", "seam_dependency", "initialized", "provisional")} for row in rows]})
        progress.append(status)
    return results, progress
