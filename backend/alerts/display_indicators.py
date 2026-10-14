"""Sequential display suffixes over an exact price snapshot, never fixed writes."""

from .indicator_state import IndicatorState

MAX_REPLAY_ROWS = 4000


def suffix(db, run, page, *, stamp, retry=None):
    from . import fixed_indicators as jobs
    from .composite_chart import chart_page
    from .composite_series import period
    from .display_snapshots import resolve
    from .storage import CompositeRevision

    if not run.revision_id:
        return None
    revision = db.get(CompositeRevision, run.revision_id)
    snapshot = resolve(db, page['display_snapshot_id'], revision, run.timeframe, stamp) if page.get('display_snapshot_id') else None
    _, _, phase, profiles = jobs._context(db, run)
    observed = snapshot.content['observations'] if snapshot else []
    pending = [period(row['start'], run.timeframe, phase)[0] for row in observed]
    pending += [bar['start'] for bar in page['bars'] if not bar.get('complete', False)]
    if run.status != 'complete':
        pending.append(run.cursor)
    if not pending:
        return None
    affected = min(pending)
    end = max(page['bars'][-1]['end'], max((row['end'] for row in observed), default=0))
    # A paginated Swing presentation follows the same current snapshot cutoff.
    if run.spec['name'] == 'SWING_SR_V1':
        latest = chart_page(db, page['composite_id'], run.timeframe, count=1,
            revision_id=run.revision_id, provisional=True, now=stamp, display_snapshot=snapshot)
        end = max(end, latest['bars'][-1]['end'] if latest['bars'] else end)
    if run.cursor <= affected:
        cursor, checkpoint = run.cursor, run.state
    else:
        safe = jobs.checkpoint_before(db, run, affected)
        cursor, checkpoint = safe if safe else (page['origin'], None)
    before, inputs = end, {}
    for _ in range(MAX_REPLAY_ROWS // jobs.PAGE_SIZE):
        part = chart_page(db, page['composite_id'], run.timeframe, count=jobs.PAGE_SIZE,
            before=before, revision_id=run.revision_id, provisional=True, now=stamp,
            display_snapshot=snapshot)
        for bar in part['bars']:
            if cursor <= bar['start'] < end:
                inputs[bar['start']] = bar
        if not part['bars'] or part['bars'][0]['start'] <= cursor or not part['has_more']:
            break
        before = part['next_before']
    else:
        if snapshot:
            from .display_indicator_jobs import request

            return request(db, run, snapshot, affected, cursor, end, checkpoint, retry=retry)
        return {'pending': True, 'affected': affected}
    # Retain the caller's accepted page projection (also allows callers with
    # in-memory pages to use the same public result interface).
    for bar in page['bars']:
        if cursor <= bar['start'] < end:
            inputs[bar['start']] = bar
    engine = IndicatorState(run.spec, checkpoint)
    if profiles:
        left, _, profile = profiles[-1]
        profiles[-1] = (left, end, profile)
    rows, dependent = [], False
    for bar in sorted(inputs.values(), key=lambda row: row['start']):
        row = {**bar, 'gap_before': jobs.gap_before(engine.state.get('last_end'), bar['start'], phase, profiles)}
        if row['gap_before']:
            dependent = False
        dependent |= not bar.get('complete', False)
        if run.spec['name'] == 'SWING_SR_V1':
            from .series_access import fixed_label

            row['chart_time'] = fixed_label(row, run.timeframe, phase)
        values = engine.display_step(row, provisional_dependency=dependent)
        if bar['start'] >= affected:
            rows.append({'start': bar['start'], 'end': bar['end'], 'values': values,
                'provisional': dependent, 'dependency_origin': engine.state.get('origin'),
                'seam_dependency': engine.state.get('seam', False), 'initialized': engine.initialized(values),
                **({'break_before': True} if row['gap_before'] else {})})
    display = getattr(engine, 'last_presentation', None)
    if display:
        display = display | {'history_complete': run.status == 'complete', 'history_revision': run.id}
    return {'rows': rows, 'display': display, 'affected': affected, 'pending': False}
