"""Normalize legacy complete-minute proofs without changing evidence meaning.

Checkpoint pages and runtime dual writes use the existing Instrument lock. Explicit
administrative final verification rescans the effective union under that lock, catching inserts with
older audit IDs or UUIDs that landed behind a saved checkpoint. No completion
flag is published until the independent compatibility union equals projection.
"""

from sqlalchemy import delete, select, update

from .source_history_store import _insert
from .storage import (
    Audit,
    Instrument,
    MarketCoverage,
    MarketCoverageCheckpoint,
    MarketCoverageProjection,
    MarketCoverageQuarantine,
)

MINUTE = 60000


def normalize(start, end):
    if any(isinstance(x, bool) or not isinstance(x, int) for x in (start, end)):
        raise ValueError('noninteger_endpoint')
    a, b = (start + MINUTE - 1) // MINUTE * MINUTE, end // MINUTE * MINUTE
    return [(a, b)] if a < b else []


def merged(spans):
    result = []
    for a, b in sorted(spans, key=lambda span: (span[0], span[1])):
        if a >= b:
            continue
        if result and a <= result[-1][1]:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result


def audit_spans(inst, details):
    if not isinstance(details, dict):
        raise ValueError('invalid_details')
    if details.get('instrument') != inst.id or details.get('basis') != inst.basis:
        return []
    if details.get('source') not in (None, 'oanda') or inst.source != 'oanda':
        raise ValueError('wrong_source')
    stamp = details['received_at']
    if isinstance(stamp, bool) or not isinstance(stamp, int):
        raise ValueError('invalid_received_at')
    cutoff = (stamp - 5000) // MINUTE * MINUTE
    result = []
    for span in details['ranges']:
        # Check both endpoints before min() can coerce a malformed/bool value.
        normalize(span['start'], span['end'])
        result.extend(normalize(span['start'], min(span['end'], cutoff)))
    return result


def _keys(inst):
    return dict(instrument_id=inst.id, source=inst.source, basis=inst.basis)


def _where(model, inst):
    return (model.instrument_id == inst.id, model.source == inst.source, model.basis == inst.basis)


def checkpoint(db, inst):
    db.execute(_insert(db)(MarketCoverageCheckpoint).values(**_keys(inst)).on_conflict_do_nothing(
        index_elements=['instrument_id', 'source', 'basis']))
    return db.get(MarketCoverageCheckpoint, (inst.id, inst.source, inst.basis))


def _quarantine(db, inst, record_id, error):
    reason = str(error) if isinstance(error, ValueError) else type(error).__name__
    if reason not in ('wrong_source', 'noninteger_endpoint', 'invalid_received_at', 'invalid_details'):
        reason = type(error).__name__
    db.execute(_insert(db)(MarketCoverageQuarantine).values(**_keys(inst), record_id=record_id,
        reason=reason).on_conflict_do_nothing(index_elements=['instrument_id', 'source', 'basis', 'record_id']))


def merge(db, inst, spans):
    """Runtime callers own the identity's Instrument lock, alongside raw proof writes."""
    state = checkpoint(db, inst)
    normalized = []
    for a, b in spans:
        normalized.extend(normalize(a, b))
    changed = False
    for a, b in merged(normalized):
        neighbors = list(db.scalars(select(MarketCoverageProjection).where(
            *_where(MarketCoverageProjection, inst), MarketCoverageProjection.start <= b,
            MarketCoverageProjection.end >= a)))
        if any(row.start <= a and row.end >= b for row in neighbors):
            continue
        for row in neighbors:
            a, b = min(a, row.start), max(b, row.end)
            db.delete(row)
        db.flush()
        db.add(MarketCoverageProjection(**_keys(inst), start=a, end=b))
        changed = True
    if changed:
        state.version += 1
        db.flush()
    return changed


def read(db, inst, left, right):
    state = db.get(MarketCoverageCheckpoint, (inst.id, inst.source, inst.basis))
    if state is None or not state.complete:
        return None
    return [dict(start=row.start, end=row.end) for row in db.scalars(select(MarketCoverageProjection).where(
        *_where(MarketCoverageProjection, inst), MarketCoverageProjection.start < right,
        MarketCoverageProjection.end > left).order_by(MarketCoverageProjection.start))]


def _structured(db, inst):
    return select(MarketCoverage).where(*_where(MarketCoverage, inst))


def _audits(inst):
    return select(Audit).where(Audit.kind == 'provider_query_coverage',
                              Audit.details['instrument'].as_string() == inst.id)


def valid_union(db, inst, *, quarantine=False, examined=None):
    """One-time verification oracle from preserved raw proofs, independent of projection."""
    spans = []
    for row in db.scalars(_structured(db, inst)):
        if examined is not None:
            examined[0] += 1
        try:
            spans.extend(normalize(row.start, row.end))
        except (ValueError, TypeError, KeyError) as error:
            if quarantine:
                _quarantine(db, inst, 'structured:' + row.id, error)
    if inst.source == 'oanda':
        for row in db.scalars(_audits(inst)):
            if examined is not None:
                examined[0] += 1
            try:
                spans.extend(audit_spans(inst, row.details))
            except (ValueError, TypeError, KeyError) as error:
                if quarantine:
                    _quarantine(db, inst, 'audit:' + str(row.id), error)
    return merged(spans)


def backfill_page(db, inst, *, limit=500, administrative=False):
    if not 1 <= limit <= 1000:
        raise ValueError('Coverage migration requires bounded pages')
    inst = db.scalar(select(Instrument).where(Instrument.id == inst.id).with_for_update())
    state = checkpoint(db, inst)
    if state.complete:
        return dict(complete=True, examined=0, version=state.version)
    examined = 0
    if state.phase == 'structured':
        rows = list(db.scalars(_structured(db, inst).where(MarketCoverage.id > state.structured_cursor)
                              .order_by(MarketCoverage.id).limit(limit)))
        spans = []
        for row in rows:
            try:
                spans.extend(normalize(row.start, row.end))
            except (ValueError, TypeError, KeyError) as error:
                _quarantine(db, inst, 'structured:' + row.id, error)
        merge(db, inst, spans)
        examined = len(rows)
        if rows:
            state.structured_cursor = rows[-1].id
        if len(rows) < limit:
            state.phase = 'audit' if inst.source == 'oanda' else 'verify'
    elif state.phase == 'audit':
        rows = list(db.scalars(_audits(inst).where(Audit.id > state.audit_cursor).order_by(Audit.id).limit(limit)))
        spans = []
        for row in rows:
            try:
                spans.extend(audit_spans(inst, row.details))
            except (ValueError, TypeError, KeyError) as error:
                _quarantine(db, inst, 'audit:' + str(row.id), error)
        merge(db, inst, spans)
        examined = len(rows)
        if rows:
            state.audit_cursor = rows[-1].id
        if len(rows) < limit:
            state.phase = 'verify'
    else:
        if not administrative:
            return dict(complete=False, examined=0, phase='verify', version=state.version,
                        maintenance_required=True)
        counter = [0]
        expected = valid_union(db, inst, quarantine=True, examined=counter)
        examined = counter[0]
        # Stable checkpoint IDs alone are insufficient: late commits and UUID
        # inserts behind the cursor are repaired from the final locked union.
        merge(db, inst, expected)
        actual = [[row.start, row.end] for row in db.scalars(select(MarketCoverageProjection).where(
            *_where(MarketCoverageProjection, inst)).order_by(MarketCoverageProjection.start))]
        if actual != expected:
            raise RuntimeError('Coverage projection differs from preserved valid proof union')
        state.complete, state.phase = True, 'complete'
        from .publication_schedule import COVERAGE, request
        request(db, inst.id, reason=COVERAGE)
    db.flush()
    return dict(complete=state.complete, examined=examined, phase=state.phase, version=state.version)


def removed_intervals(previous, current):
    """Exact difference of disjoint proof unions, keeping unrelated history intact."""
    result = []
    for left, right in previous:
        cursor = left
        for a, b in current:
            if b <= cursor:
                continue
            if a >= right:
                break
            if a > cursor:
                result.append((cursor, min(a, right)))
            cursor = max(cursor, b)
            if cursor >= right:
                break
        if cursor < right:
            result.append((cursor, right))
    return result


def _revoke_dependents(db, inst, removed):
    """Explicit maintenance exception to normal immutable completeness confirmation."""
    from .chart_aggregation import PERIODS, enqueue_aggregation
    from .storage import Bar, ChartPublication, ChartPublishedBar, now_ms

    stamp = now_ms()
    for left, right in removed:
        # M1 observations remain valid. Only proof-dependent higher periods are
        # withdrawn, then recomputed from retained minutes and remaining proofs.
        db.execute(update(Bar).where(Bar.instrument_id == inst.id,
            Bar.timeframe.in_(PERIODS), Bar.start < right, Bar.end > left,
            Bar.complete.is_(True)).values(complete=False, volume_complete=False,
                revision=Bar.revision + 1, volume_revision=Bar.volume_revision + 1))
        for row in db.scalars(select(ChartPublishedBar).where(
                ChartPublishedBar.instrument_id == inst.id, ChartPublishedBar.timeframe != 'M1',
                ChartPublishedBar.start < right, ChartPublishedBar.end > left,
                ChartPublishedBar.complete.is_(True))):
            row.complete = False
            row.payload = {**row.payload, 'complete': False, 'volume_complete': False}
            row.revision += 1
            pub = db.get(ChartPublication, (inst.id, row.timeframe))
            pub.complete_count -= 1
            pub.revision += 1
        enqueue_aggregation(db, inst.id, left, right, stamp)
    if removed:
        db.add(Audit(kind='coverage_proof_revoked', details=dict(
            instrument=inst.id, source=inst.source, basis=inst.basis, ranges=[
                dict(start=a, end=b) for a, b in removed])))


def rebuild(db, inst):
    """Explicit administrative proof correction; never called from publisher ticks.

    This locked full proof verification and scoped revocation may be expensive.
    Run in a maintenance window; ordinary checkpoint pages stop before it.
    """
    db.scalar(select(Instrument).where(Instrument.id == inst.id).with_for_update())
    state = checkpoint(db, inst)
    previous = [[row.start, row.end] for row in db.scalars(select(MarketCoverageProjection).where(
        *_where(MarketCoverageProjection, inst)).order_by(MarketCoverageProjection.start))]
    # If migration has not completed, retained published/source intervals are
    # conservatively rechecked rather than trusting a partial proof projection.
    if not state.complete:
        from .storage import Bar
        previous = merged(previous + [(row.start, row.end) for row in db.scalars(select(Bar).where(
            Bar.instrument_id == inst.id, Bar.timeframe != 'M1', Bar.complete.is_(True)))])
    state.complete, state.phase = False, 'verify'
    db.execute(delete(MarketCoverageProjection).where(*_where(MarketCoverageProjection, inst)))
    state.version += 1
    result = backfill_page(db, inst, administrative=True)
    current = [[row.start, row.end] for row in db.scalars(select(MarketCoverageProjection).where(
        *_where(MarketCoverageProjection, inst)).order_by(MarketCoverageProjection.start))]
    _revoke_dependents(db, inst, removed_intervals(previous, current))
    from .chart_aggregation import enqueue_aggregation
    from .storage import now_ms
    for left, right in removed_intervals(current, previous):
        enqueue_aggregation(db, inst.id, left, right, now_ms())
    db.flush()
    return result
