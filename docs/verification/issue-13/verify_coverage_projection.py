"""Replay the preserved proof export only in this task's isolated Ubuntu PG."""

import gzip
import json
import os
import time
import uuid
from pathlib import Path

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from alerts import market, storage as s
from alerts.coverage_projection import backfill_page

HERE = Path(__file__).resolve().parent


def main():
    url = make_url(os.environ['ALERTS_DATABASE_URL'])
    if (url.host, url.database, url.username) != ('postgres', 'issue13', 'issue13'):
        raise SystemExit('Only the task-isolated Ubuntu Compose database is accepted')
    schema = 'proof_replay_' + uuid.uuid4().hex
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(url, connect_args={'options': f'-csearch_path={schema}'}, pool_size=1, max_overflow=0)
    factory = sessionmaker(engine, expire_on_commit=False)
    records = []
    with gzip.open(HERE / 'production-coverage.jsonl.gz', 'rt') as source:
        records = [json.loads(line) for line in source]
    assert records[-1]['kind'] == 'complete'
    expected = {row['instrument']: row['compatibility_union'] for row in
        json.loads((HERE / 'production-coverage-comparison.json').read_text())['targets']}
    try:
        s.bootstrap(engine)
        with factory.begin() as db:
            for row in records:
                if row['kind'] == 'instrument':
                    inst = db.get(s.Instrument, row['id'])
                    inst.source, inst.basis = row['source'], row['basis']
            audits = [dict(id=row['id'], kind='provider_query_coverage', at=row['details']['received_at'],
                           details=row['details']) for row in records if row['kind'] == 'audit']
            coverage = [dict(id=str(uuid.uuid4()), **{key: row[key] for key in
                ('instrument_id', 'source', 'basis', 'start', 'end', 'queried_at')}, observed=0)
                for row in records if row['kind'] == 'coverage']
            for model, rows in ((s.Audit, audits), (s.MarketCoverage, coverage)):
                for offset in range(0, len(rows), 1000):
                    db.execute(model.__table__.insert(), rows[offset:offset + 1000])
        targets = []
        for ident in expected:
            pages, queries = [], []
            def record(conn, cursor, statement, parameters, context, many):
                queries.append(statement)
            begun = time.monotonic()
            while True:
                start = time.monotonic()
                with factory.begin() as db:
                    result = backfill_page(db, db.get(s.Instrument, ident), limit=500, administrative=True)
                pages.append(dict(seconds=time.monotonic() - start, **result))
                if result['complete']:
                    break
            event.listen(engine, 'before_cursor_execute', record)
            try:
                with factory.begin() as db:
                    actual = [[span['start'], span['end']] for span in market.stored_coverage(
                        db, db.get(s.Instrument, ident), 0, 9999999999999)]
            finally:
                event.remove(engine, 'before_cursor_execute', record)
            assert actual == expected[ident], ident + ' differs from preserved independent comparison'
            assert not any('FROM audit_events' in query for query in queries)
            with factory.begin() as db:
                assert not list(db.scalars(select(s.MarketCoverageQuarantine)))
            targets.append(dict(instrument=ident, seconds=time.monotonic() - begun, pages=pages,
                intervals=actual, equivalent=True, audit_reads_after_completion=0))
            print(ident + ' proof replay passed', flush=True)
        report = dict(environment='Ubuntu isolated mw-issue13-optimized PostgreSQL',
            raw_audits=len(audits), raw_structured=len(coverage), targets=targets,
            scope='Archived source/basis proof union equality and checkpoint/query behavior; no production writes')
        output = Path('/results') / 'coverage-replay.json'
        with output.open('x') as file:
            json.dump(report, file, indent=2)
            file.write('\n')
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


if __name__ == '__main__':
    main()
