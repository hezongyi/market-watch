"""Bounded service fairness and immutable input reuse across actual ticks."""
from alerts import history_artifacts as artifacts
from alerts.storage import HistoryArtifact, HistoryVersion
from sqlalchemy import select
from test_history_artifacts import publish
from test_market_contracts import minute


def test_two_versions_and_periods_advance_before_any_one_finishes(database):
    end = 16000 * 60000
    rows = tuple(minute(at) for at in range(0, end, 60000))
    versions = [publish(database, end=end, rows=rows)[0] for _ in range(2)]
    with database.begin() as db:
        for ident in versions:
            artifacts.request_artifacts(db, db.get(HistoryVersion, ident), ["M1", "H1"])
    for _ in range(4):
        assert artifacts.artifact_tick()
    with database() as db:
        cursors = list(db.scalars(select(HistoryArtifact.cursor)))
        assert cursors == [5000 * 60000] * 4, "each runnable version/period receives one page"


def test_price_decoding_reused_across_committed_pages_and_periods(database, monkeypatch):
    end = 10001 * 60000
    ident = publish(database, end=end, rows=tuple(minute(at) for at in range(0, end, 60000)))[0]
    with database.begin() as db:
        artifacts.request_artifacts(db, db.get(HistoryVersion, ident), ["M1", "H1"])
    original = artifacts.version_price_rows
    calls = []
    def decode(rows, manifest):
        calls.append(len(rows))
        return original(rows, manifest)
    monkeypatch.setattr(artifacts, "version_price_rows", decode)
    for _ in range(6):
        assert artifacts.artifact_tick(ident)
    assert len(calls) == 1, "one immutable source chunk is normalized once across all six pages"


def test_durable_progress_counts_observations_not_unknown_query_minutes(database):
    from alerts.history_versions import version_report
    ident = publish(database, end=20000 * 60000,
        rows=tuple(minute(at) for at in range(0,10001 * 60000,60000)))[0]
    with database.begin() as db:
        artifacts.request_artifacts(db,db.get(HistoryVersion,ident),['M1','H1'])
        progress=version_report(db,ident)['derivation']
        assert progress['processed_rows']==0 and progress['total_rows']==20002
        assert progress['estimated_remaining_seconds'] is None
    assert artifacts.artifact_tick(ident)
    with database() as db:
        progress=version_report(db,ident)['derivation']
        assert progress['processed_rows']==5000
        assert progress['total_rows']==20002
        assert progress['estimated_remaining_seconds'] > 0
    # A worker restart loses only the LRU, not committed progress/accumulator.
    with artifacts._input_lock:
        artifacts._inputs.clear();artifacts._input_bytes=0
    while artifacts.artifact_tick(ident): pass
    with database() as db:
        progress=version_report(db,ident)['derivation']
        assert progress['processed_rows']==progress['total_rows']==20002
        assert progress['published_periods']==progress['total_periods']==2
        assert progress['estimated_remaining_seconds']==0


def test_two_large_task_blocks_stay_warm_without_exceeding_memory_budget(database,monkeypatch):
    end=44001*60000
    rows=tuple(minute(at) for at in range(0,end,60000))
    versions=[publish(database,end=end,rows=rows)[0] for _ in range(2)]
    with database.begin() as db:
        for ident in versions:artifacts.request_artifacts(db,db.get(HistoryVersion,ident),['M1','H1'])
    original=artifacts.version_price_rows;calls=[]
    def decode(rows,manifest):calls.append(len(rows));return original(rows,manifest)
    monkeypatch.setattr(artifacts,'version_price_rows',decode)
    for _ in range(12):assert artifacts.artifact_tick()
    assert calls==[44001,44001]
    assert artifacts._input_bytes <= artifacts._INPUT_LIMIT


def test_eta_uses_recent_committed_wall_throughput_and_expires(database, monkeypatch):
    ident = publish(database, end=10000 * 60000, rows=tuple(
        minute(at) for at in range(0, 10000 * 60000, 60000)))[0]
    clock = 1000000
    monkeypatch.setattr(artifacts, 'now_ms', lambda: clock)
    with database.begin() as db:
        version = db.get(HistoryVersion, ident)
        artifacts.request_artifacts(db, version, ['M1', 'H1'])
        for period in db.scalars(select(HistoryArtifact)):
            period.manifest = {'progress': {'processed_rows': 5000, 'work_seconds': 1,
                'recent_batches': [
                    {'start': clock - 120000, 'end': clock - 119000, 'rows': 4500},
                    {'start': clock - 10000, 'end': clock - 9000, 'rows': 500},
                ]}}
    with database() as db:
        progress = artifacts.derivation_progress(db, db.get(HistoryVersion, ident))
        # 1000 recent rows in ten wall seconds, including time awaiting service;
        # the much faster cumulative CPU rate and old samples must not influence ETA.
        assert progress['estimated_remaining_seconds'] == 100
    clock += 60001
    with database() as db:
        assert artifacts.derivation_progress(db, db.get(HistoryVersion, ident))[
            'estimated_remaining_seconds'] is None


def test_eta_after_resume_waits_for_a_new_committed_batch(database, monkeypatch):
    from alerts.storage import HistoryRun
    ident = publish(database, end=10001 * 60000, rows=tuple(
        minute(at) for at in range(0, 10001 * 60000, 60000)))[0]
    monkeypatch.setattr(artifacts, 'now_ms', lambda: 1000000)
    with database.begin() as db:
        version = db.get(HistoryVersion, ident)
        artifacts.request_artifacts(db, version, ['H1'])
        db.add(HistoryRun(version_id=ident, dataset_id=version.dataset_id,
            request_id=ident, request_hash=ident, kind='recheck', refresh_start=0,
            refresh_end=version.end, desired_state='paused', updated_at=999000))
        period = db.scalar(select(HistoryArtifact))
        period.manifest = {'progress': {'processed_rows': 5000, 'work_seconds': 1,
            'recent_batches': [{'start': 990000, 'end': 991000, 'rows': 5000}]}}
    with database() as db:
        assert artifacts.derivation_progress(db, db.get(HistoryVersion, ident))[
            'estimated_remaining_seconds'] is None
    with database.begin() as db:
        run = db.get(HistoryRun, ident)
        run.desired_state, run.updated_at = 'running', 999500
    with database() as db:
        assert artifacts.derivation_progress(db, db.get(HistoryVersion, ident))[
            'estimated_remaining_seconds'] is None
    assert artifacts.artifact_tick(ident)
    with database() as db:
        progress = artifacts.derivation_progress(db, db.get(HistoryVersion, ident))
        assert progress['estimated_remaining_seconds'] > 0
        batches = db.scalar(select(HistoryArtifact).where(
            HistoryArtifact.timeframe == 'H1')).manifest['progress']['recent_batches']
        assert batches[-1]['rows'] == 5000 and batches[-1]['start'] == 1000000
