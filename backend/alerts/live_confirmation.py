"""Confirmation health is independent of sampling, fenced by the account owner.

Additive Preference JSON keeps old databases/readers usable. No price, coverage
or ready flag is derived from this record; only confirmed minute ingestion does that.
"""
from .storage import Instrument, MarketDataset, Preference


def health(db, state):
    row = db.get(Preference, 'live_confirmation:v1:' + state.dataset_id)
    return dict(row.value) if row and row.value.get('epoch') == state.epoch else {}


def sampling_evidence(db, state, *, result=None):
    """Safe sampling evidence, independent of the confirmation incident."""
    key = 'live_sampling:v1:' + state.dataset_id
    row = db.get(Preference, key)
    if result is not None:
        evidence = result.model_dump(mode='json', exclude_none=True) if not result.successful else {}
        value = {'epoch': state.epoch, 'evidence': evidence}
        if row:
            row.value = value
        else:
            db.add(Preference(key=key, value=value))
        return evidence
    return dict(row.value.get('evidence', {})) if row and row.value.get('epoch') == state.epoch else {}


def outcome(db, state, *, error=None, evidence=None, stamp, reset=False):
    from .config import settings
    from .notice_instruments import snapshot
    from .notification_sources import _append

    key = 'live_confirmation:v1:' + state.dataset_id
    row = db.get(Preference, key)
    previous = dict(row.value) if row else {}
    value = health(db, state)
    source = state.dataset_id + ':confirmation'
    def append(kind, old, facts=None):
        if settings.notification_center_sources_enabled:
            _append(db.connection(), kind, source, {'source_kind': 'market',
                'dedupe_key': source + ':' + str(old.get('epoch')) + ':' + str(old.get('incident', 0)), **(facts or {})})
    if previous.get('open') and (reset or previous.get('epoch') != state.epoch):
        append('observation_end', previous)
    if reset:
        value = {}
    value = {'epoch': state.epoch, 'incident': 0, **value}
    if error:
        if not value.get('open'):
            value['incident'] += 1
        dataset = db.get(MarketDataset, state.dataset_id)
        inst = db.get(Instrument, dataset.instrument_id)
        display = snapshot({'series_kind': 'managed', 'symbol': dataset.logical_symbol, 'name': inst.label})
        append('task_failure', value, {'code': 'MINUTE_CONFIRMATION_DELAYED',
            'title': '分钟确认延迟', 'attempt': str(state.revision), 'notify_web': not value.get('open'),
            'instrument_display': display,
            'context': {'instrument': dataset.instrument_id, 'dataset_id': state.dataset_id,
                        'series_kind': 'managed', 'timeframe': 'M1', 'consumer': 'confirmation',
                        'source_id': source, 'epoch': state.epoch},
            'evidence': {'operation': 'candles', **(evidence or {}), 'error': error}})
        value.update(open=True, error=error, evidence=evidence or {}, observed_at=stamp,
            window_start=min(value.get('window_start', (evidence or {}).get('window_start', 0)), (evidence or {}).get('window_start', 0)),
            window_end=max(value.get('window_end', 0), (evidence or {}).get('window_end', 0)))
    else:
        if value.get('open'):
            append('recovery', value)
        value.update(open=False, error=None, evidence={}, observed_at=stamp)
        value.pop('window_start', None)
        value.pop('window_end', None)
    if row:
        row.value = value
    else:
        db.add(Preference(key=key, value=value))
