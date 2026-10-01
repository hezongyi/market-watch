"""Destructive fault injection, restricted to the local dual acceptance fixture.

PYTHONPATH=backend .venv/bin/python scripts/verify_dual_recovery.py
Never uses shared/production databases. Saves a private pg_dump before changing
acquisition staging; visible published snapshots are deliberately left intact.
"""
import json
import os
import subprocess
import time
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
ENV = Path('/tmp/mw-dual-acceptance/api.env')
OUTPUT = ROOT / 'docs/verification/dual-container/recovery-live.json'
COMPOSE = ('docker compose --env-file /tmp/mw-dual-acceptance/compose.env '
           '-p market-watch-dual-acceptance -f compose.acceptance.yaml '
           '-f compose.dual-acceptance.yaml ')


def docker(command, *, source=None):
    result = subprocess.run(['sg', 'docker', '-c', command], cwd=ROOT,
                            capture_output=True, text=True, input=source)
    if result.returncode:
        raise RuntimeError('Acceptance Docker command failed; inspect container state')
    return result.stdout


def fixture_environment():
    for line in ENV.read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key.startswith('ALERTS_'):
            os.environ[key] = value
    url = make_url(os.environ['ALERTS_DATABASE_URL'])
    assert url.host == 'market-watch-postgres-isolated'
    assert url.database == 'market_watch_dual', 'Fault injection requires the isolated fixture'
    os.environ['ALERTS_DATABASE_URL'] = url.set(host='127.0.0.1', port=15432).render_as_string(hide_password=False)
    os.environ['ALERTS_DATABASE_POOL_SIZE'] = '1'
    os.environ['ALERTS_DATABASE_MAX_OVERFLOW'] = '0'
    os.environ['ALERTS_DATABASE_APPLICATION_NAME'] = 'dual-recovery-verifier'
    os.environ['ALERTS_DELIVERY_ENABLED'] = 'false'


def main():
    fixture_environment()
    from alerts.chart_history_plan import control_plan
    from alerts.managed_dataset import status
    from alerts.storage import (Bar, ChartHistoryPlan, ChartPublication, ChartPublishedBar,
                                ImportJob, Instrument, MarketCoverage, now_ms, transaction)

    evidence = {'passed': False, 'started_at': now_ms(), 'samples': [],
                'database': 'market_watch_dual', 'fault': 'remove recent acquisition M1 and coverage'}
    original_history = None

    def save():
        OUTPUT.write_text(json.dumps(evidence, indent=2, ensure_ascii=False))

    def note(phase, **values):
        evidence['samples'].append({'phase': phase, 'at': now_ms(), **values})
        save()
        print(json.dumps(evidence['samples'][-1], ensure_ascii=False), flush=True)

    def snapshot(db):
        return [(row.start, row.payload) for row in db.scalars(select(ChartPublishedBar).where(
            ChartPublishedBar.instrument_id == 'BTCUSDT', ChartPublishedBar.timeframe == 'M5')
            .order_by(ChartPublishedBar.start))]

    def repairs(db):
        return list(db.scalars(select(ImportJob).where(
            ImportJob.instrument_id == 'BTCUSDT', ImportJob.priority == 0,
            ImportJob.status.in_(['pending', 'running']))))

    try:
        backup = Path('/tmp/mw-dual-recovery-pre.dump')
        with backup.open('wb') as stream:
            backup.chmod(0o600)
            result = subprocess.run(['sg', 'docker', '-c',
                'docker exec market-watch-postgres-isolated sh -c '
                """'pg_dump -U "${POSTGRES_USER:-postgres}" -Fc market_watch_dual'"""], stdout=stream,
                stderr=subprocess.PIPE)
        assert result.returncode == 0 and backup.stat().st_size > 0
        note('backup', backup=str(backup))
        docker(COMPOSE + 'stop realtime-worker chart-history-worker chart-aggregation-worker')
        with transaction() as db:
            plan = db.get(ChartHistoryPlan, 'OANDA:EUR_GBP')
            original_history = plan.status
            control_plan(db, plan.instrument_id, 'resume', now_ms())
            # These two fixture records were automatically adopted by the
            # unshipped candidate, before the complete-minute fix. No explicitly
            # submitted user target is changed, including EUR_CHF/EUR_GBP.
            normalized = []
            for ident in ('EURUSD', 'XAUUSD'):
                old = db.get(ChartHistoryPlan, ident)
                if old.target_start % 60000:
                    assert old.status == 'complete'
                    assert db.scalar(select(func.count()).select_from(ImportJob).where(
                        ImportJob.instrument_id == ident, ImportJob.chart_plan.is_(True))) == 0
                    old.target_start = (old.target_start + 59999) // 60000 * 60000
                    old.target_end = old.target_end // 60000 * 60000
                    old.cursor = old.target_start
                    normalized.append(ident)
            cutoff = (now_ms() - 5000) // 60000 * 60000
            gap = cutoff - 150 * 60000
            earliest = db.scalar(select(func.min(Bar.start)).where(
                Bar.instrument_id == 'BTCUSDT', Bar.timeframe == 'M1'))
            assert earliest < gap, 'Fixture needs a pre-outage M1 anchor'
            before = snapshot(db)
            assert before
            deleted = db.execute(delete(Bar).where(
                Bar.instrument_id == 'BTCUSDT', Bar.timeframe == 'M1', Bar.start >= gap)).rowcount
            for coverage in db.scalars(select(MarketCoverage).where(
                    MarketCoverage.instrument_id == 'BTCUSDT', MarketCoverage.end > gap)):
                if coverage.start >= gap:
                    db.delete(coverage)
                else:
                    coverage.end = gap
            assert deleted > 120
            assert snapshot(db) == before, 'Fault must not erase visible snapshots'
        note('fault_injected', gap_start=gap, gap_end=cutoff, deleted_minutes=deleted,
             published_snapshot_preserved=True, normalized_adopted_fixture=normalized)

        # Real provider + actual production queue_recovery path, without consuming
        # its repair queue yet. No mocked candle payload or synthetic repair job.
        docker(COMPOSE + 'exec -T api python -', source=(
            'from alerts.market import once\nfrom alerts.market_resources import lane\n'
            'with lane("realtime"):\n    once(symbol="BTCUSDT", include_viewers=True)\n'))
        with transaction() as db:
            queued = repairs(db)
            assert queued, 'The actual live poll must discover the outage gap'
            assert all(j.start >= cutoff - 86400000 and j.end - j.start <= 120 * 60000 for j in queued)
            for job in queued:
                job.next_at = now_ms() + 120000
            repair_ids = [job.id for job in queued]
            covered_again = db.scalar(select(func.max(Bar.end)).where(
                Bar.instrument_id == 'BTCUSDT', Bar.timeframe == 'M1'))
            history_before = [(j.id, j.cursor, j.status) for j in db.scalars(select(ImportJob).where(
                ImportJob.priority >= 100, ImportJob.status.in_(['pending', 'running'])))]
            history_count = db.scalar(select(func.count()).select_from(ImportJob).where(ImportJob.priority >= 100))
            assert snapshot(db) == before
        note('automatic_repair_queued', repair_ids=repair_ids, latest_m1=covered_again,
             history_count=history_count, hold='next_at deferred to observe priority while realtime polls continue')
        docker(COMPOSE + 'start realtime-worker chart-history-worker chart-aggregation-worker')
        # Observe a minute boundary with the repair queue deliberately held.
        deadline = time.monotonic() + 100
        advanced = False
        while time.monotonic() < deadline:
            with transaction() as db:
                current = db.scalar(select(func.max(Bar.end)).where(
                    Bar.instrument_id == 'BTCUSDT', Bar.timeframe == 'M1'))
                historical = [(j.id, j.cursor, j.status) for j in db.scalars(select(ImportJob).where(
                    ImportJob.priority >= 100, ImportJob.status.in_(['pending', 'running'])))]
                count = db.scalar(select(func.count()).select_from(ImportJob).where(ImportJob.priority >= 100))
                assert repairs(db), 'Deferred recent repair must remain queued'
                assert count == history_count and historical == history_before, 'History must yield to recent repair'
                if current > covered_again:
                    advanced = True
                    note('live_advanced_while_history_yielded', latest_m1=current,
                         latency_ms=now_ms() - current, history_count=count)
                    break
            time.sleep(1)
        assert advanced, 'Realtime must advance even while the repair backlog is held'
        with transaction() as db:
            for ident in repair_ids:
                db.get(ImportJob, ident).next_at = now_ms()
        released = time.monotonic()
        note('repair_released')
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            with transaction() as db:
                jobs = [db.get(ImportJob, ident) for ident in repair_ids]
                if all(job.status == 'complete' for job in jobs):
                    repaired = db.scalar(select(func.count()).select_from(Bar).where(
                        Bar.instrument_id == 'BTCUSDT', Bar.timeframe == 'M1',
                        Bar.start >= gap, Bar.end <= cutoff, Bar.complete.is_(True)))
                    assert repaired == 150
                    note('repair_complete', elapsed_ms=round((time.monotonic() - released) * 1000),
                         repaired_minutes=repaired, no_duplicate_m1=True)
                    break
            time.sleep(1)
        else:
            raise AssertionError('Recent repair did not complete within 120s')
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            with transaction() as db:
                count = db.scalar(select(func.count()).select_from(ImportJob).where(ImportJob.priority >= 100))
                if count > history_count:
                    pub = db.get(ChartPublication, ('BTCUSDT', 'M5'))
                    note('history_resumed', history_count=count, published_end=pub.end)
                    break
            time.sleep(1)
        else:
            raise AssertionError('History did not resume after repair')
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            with transaction() as db:
                inst = db.get(Instrument, 'BTCUSDT')
                state = status(db, inst, 'M5')
                adopted = [status(db, db.get(Instrument, ident), 'M5') for ident in ('EURUSD', 'XAUUSD')]
                if state['end'] >= current and all(item['initialized'] for item in adopted):
                    note('publication_recovered', dataset=state, adopted_initialized=True)
                    break
            time.sleep(1)
        else:
            raise AssertionError('Publication did not recover')
        evidence['passed'] = True
    except Exception as error:
        evidence['error_type'] = type(error).__name__
        if isinstance(error, AssertionError):
            evidence['assertion'] = str(error)
        raise
    finally:
        # Return history to its original cancelled state; live maintenance stays
        # enabled and automatically repairs any unfinished fault after failure.
        if original_history == 'cancelled':
            with transaction() as db:
                control_plan(db, 'OANDA:EUR_GBP', 'cancel', now_ms())
        docker(COMPOSE + 'start realtime-worker chart-history-worker chart-aggregation-worker')
        evidence['finished_at'] = now_ms()
        save()


if __name__ == '__main__':
    main()
