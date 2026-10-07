"""Normalize legacy complete-minute proofs without changing evidence meaning.

Checkpoint pages and runtime dual writes use the existing Instrument lock. Final
verification rescans the effective union under that lock, catching inserts with
older audit IDs or UUIDs that landed behind a saved checkpoint. No completion
flag is published until the independent compatibility union equals projection.
"""

from sqlalchemy import delete, select

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
    for a, b in sorted(spans):
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


def valid_union(db, inst, *, quarantine=False):
    """One-time verification oracle from preserved raw proofs, independent of projection."""
    spans = []
    for row in db.scalars(_structured(db, inst)):
        try:
            spans.extend(normalize(row.start, row.end))
        except (ValueError, TypeError, KeyError) as error:
            if quarantine:
                _quarantine(db, inst, 'structured:' + row.id, error)
    if inst.source == 'oanda':
        for row in db.scalars(_audits(inst)):
            try:
                spans.extend(audit_spans(inst, row.details))
            except (ValueError, TypeError, KeyError) as error:
                if quarantine:
                    _quarantine(db, inst, 'audit:' + str(row.id), error)
    return merged(spans)


def backfill_page(db, inst, *, limit=500):
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
        expected = valid_union(db, inst, quarantine=True)
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


def rebuild(db, inst):
    """Administrative proof removal/correction recomputes provenance and wakes dependents."""
    db.scalar(select(Instrument).where(Instrument.id == inst.id).with_for_update())
    state = checkpoint(db, inst)
    state.complete, state.phase = False, 'verify'
    db.execute(delete(MarketCoverageProjection).where(*_where(MarketCoverageProjection, inst)))
    state.version += 1
    return backfill_page(db, inst)
