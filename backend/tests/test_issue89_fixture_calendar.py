"""Pure fixed-time checks for the offline acceptance input, without a database."""

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('issue89_fixture',
    Path(__file__).resolve().parents[2] / 'scripts/issue89_acceptance_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


@pytest.mark.parametrize('now,tail', [
    ('2026-10-21T03:50+00:00', '2026-10-21T01:00+00:00'),
    ('2026-10-21T14:00+00:00', '2026-10-21T13:00+00:00'),
    ('2026-10-22T02:00+00:00', '2026-10-22T01:00+00:00'),
    ('2026-10-24T12:00+00:00', '2026-10-23T17:00+00:00'),
    ('2026-03-08T21:30+00:00', '2026-03-08T21:00+00:00'),
    ('2026-11-01T22:30+00:00', '2026-11-01T22:00+00:00'),
])
def test_h4_recent_tail_and_complete_calendar(now, tail):
    starts = fixture.fixture_starts('H4', stamp(now))
    assert len(starts) == len(set(starts)) == 1800
    assert starts == sorted(starts)
    assert starts[-1] == stamp(tail)
    for previous, following in zip(starts, starts[1:]):
        local = datetime.fromtimestamp(previous / 1000, UTC).astimezone(fixture.ZONE)
        assert local.hour in (1, 5, 9, 13, 17, 21)
        assert fixture.next_fixture_start('H4', previous) == following


@pytest.mark.parametrize('frame,previous,following', [
    ('H4', '2026-03-06T18:00+00:00', '2026-03-08T21:00+00:00'),
    ('H4', '2026-10-30T17:00+00:00', '2026-11-01T22:00+00:00'),
    ('H1', '2026-10-23T20:00+00:00', '2026-10-25T21:00+00:00'),
])
def test_rollover_uses_calendar_and_never_seeds_a_future_bar(frame, previous, following):
    assert fixture.next_fixture_start(frame, stamp(previous)) == stamp(following)
    now = stamp(following) + 1800000
    starts = fixture.fixture_starts(frame, now, 1801)
    delayed_tail = starts[:-1][-1]
    assert delayed_tail == stamp(previous)
    assert fixture.next_fixture_start(frame, delayed_tail) == starts[-1] <= now


def test_delayed_fixture_observation_satisfies_native_first_read(database, monkeypatch):
    from alerts import native_history_loads as loads
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from alerts import storage
    from alerts.chart_api import DataQuery
    from sqlalchemy import select

    clock = [stamp('2026-10-21T14:15+00:00')]
    monkeypatch.setattr(storage, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(cache, 'now_ms', lambda: clock[0])
    monkeypatch.setenv('MW_PREVIEW_TASK', 'mw-issue89-20261021')
    monkeypatch.setattr('sys.argv', ['fixture', 'seed', '--rollover-ready'])
    fixture.main()
    queries = [DataQuery(instrument='OANDA:AUD_JPY', series_kind='provider',
        timeframe=frame, limit=183, countBack=183, before=clock[0]+1,
        firstDataRequest=True, native_history={'chart_count': 1}) for frame in ('H1', 'H4')]
    before = {}
    with database() as db:
        for dataset in db.scalars(select(storage.ProviderDataset)):
            before[dataset.id] = (dataset.metadata_json['indicator_history_epoch'], dataset.revision)
    clock[0] += 180000
    for query in queries:
        with pytest.raises(cache.HistoryPending):
            loads.read_cached(query.model_copy(update={'before': clock[0]+1}))
    monkeypatch.setattr('sys.argv', ['fixture', 'observe'])
    fixture.main()
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: pytest.fail('offline observation only'))
    for query in queries:
        result = loads.read_cached(query.model_copy(update={'before': clock[0]+1}))
        assert len(result['bars']) >= 183
        assert result['bars'][-1]['start'] < clock[0]
    with database() as db:
        for dataset in db.scalars(select(storage.ProviderDataset)):
            assert (dataset.metadata_json['indicator_history_epoch'], dataset.revision) == before[dataset.id]
            assert dataset.coverage[-1][1] == clock[0]+1
            assert dataset.latest_at == clock[0]
    monkeypatch.setattr('sys.argv', ['fixture', 'rollover', '--frame', 'H1'])
    fixture.main()
    monkeypatch.setattr('sys.argv', ['fixture', 'seed', '--rollover-ready'])
    fixture.main()
    query = queries[0].model_copy(update={'before': clock[0]+1})
    reseeded = loads.read_cached(query)
    assert reseeded['bars'][-1]['start'] == fixture.fixture_starts('H1', clock[0], 1801)[-2]
    # Replay is a new synthetic baseline: a prior rollover must not leave the
    # monotonic production high-water mark ahead of its deliberately older tail.
    for frame in ('H1', 'H4'):
        monkeypatch.setattr('sys.argv', ['fixture', 'rollover', '--frame', frame])
        fixture.main()
    monkeypatch.setattr('sys.argv', ['fixture', 'seed', '--rollover-ready'])
    fixture.main()
    with database() as db:
        epochs = {d.id: d.metadata_json['indicator_history_epoch']
                  for d in db.scalars(select(storage.ProviderDataset))}
    for frame in ('H1', 'H4'):
        monkeypatch.setattr('sys.argv', ['fixture', 'tail', '--frame', frame])
        fixture.main()
    with database() as db:
        for dataset in db.scalars(select(storage.ProviderDataset)):
            assert dataset.metadata_json['indicator_history_epoch'] == epochs[dataset.id], (
                'a reseeded forming tail must not be mistaken for an early correction')
