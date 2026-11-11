"""Run inside the task API container; never target a shared or production DB."""

import hashlib
import json
import secrets
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from alerts import notification_center as center
from alerts.storage import LoginSession, Session, engine, now_ms
from sqlalchemy import event, text

assert engine.url.host == 'postgres' and engine.url.database == 'cpu_rehearsal'


def http(path, body=None, headers=None):
    request = Request('http://127.0.0.1:8000'+path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json', **(headers or {})})
    with urlopen(request, timeout=15) as response:
        assert response.status == 200
        return json.load(response)


report = {'scope': 'Ubuntu task API with restored scoped snapshot; no live collector',
          'health': http('/healthz')['status'], 'ready': http('/readyz')['status']}
try:
    http('/api/health')
except HTTPError as error:
    assert error.code == 401
    report['unauthenticated_status'] = error.code
else:
    raise AssertionError('Authenticated API unexpectedly public')

token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
token_hash = hashlib.sha256(token.encode()).hexdigest()
with Session.begin() as db:
    db.add(LoginSession(token_hash=token_hash, csrf=csrf, expires=now_ms()+60000))
try:
    headers = {'Cookie': 'session='+token, 'X-CSRF-Token': csrf}
    status = http('/api/market-data/dataset',
                  {'instrument': 'BTCUSDT', 'timeframe': 'M1'}, headers)
    assert status['coverage_projection']['complete']
    assert not status['coverage_projection']['maintenance_required']
    report['coverage_projection'] = status['coverage_projection']
    data = http('/api/charts/data', {'instrument': 'BTCUSDT', 'timeframe': 'M1',
                                   'published': True, 'limit': 5}, headers)
    assert data['bars'] and all(row['complete'] for row in data['bars'])
    report['published_complete_bars_read'] = len(data['bars'])
finally:
    with Session.begin() as db:
        db.delete(db.get(LoginSession, token_hash))

# Capture the production query at its actual call site, before it can project
# any source events. Its stream initialization and locks are rolled back.
queries = []


class Captured(Exception):
    pass


def record(conn, cursor, statement, parameters, context, many):
    if statement.startswith('SELECT') and 'FROM audit_events' in statement and 'notice_source_receipts' in statement:
        queries.append((statement, parameters))
        raise Captured()


event.listen(engine, 'before_cursor_execute', record)
try:
    try:
        with Session.begin() as db:
            center.project(db)
    except Captured:
        pass
finally:
    event.remove(engine, 'before_cursor_execute', record)
assert len(queries) == 1
statement, parameters = queries[0]
with engine.connect() as conn:
    transaction = conn.begin()
    try:
        # Model an idle poll with every existing source already acknowledged.
        # These receipts and both DDL operations are rolled back together.
        conn.execute(text("INSERT INTO notice_source_receipts(source_key,at) "
            "SELECT 'audit:' || id::text,0 FROM audit_events WHERE kind='notice_source' "
            "ON CONFLICT DO NOTHING"))
        conn.execute(text('SET LOCAL jit=off'))
        conn.execute(text("SET LOCAL statement_timeout='10s'"))
        conn.execute(text('DROP INDEX IF EXISTS ix_audit_events_notice_source_id'))
        baseline = conn.exec_driver_sql('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement,
                                       parameters).scalar_one()[0]
        conn.execute(text("CREATE INDEX ix_audit_events_notice_source_id "
                          "ON audit_events(id) WHERE kind='notice_source'"))
        indexed = conn.exec_driver_sql('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement,
                                      parameters).scalar_one()[0]
        def filtered(node):
            return node.get('Rows Removed by Filter', 0) + sum(filtered(p) for p in node.get('Plans', []))
        report['notice_idle_query'] = {
            'before_ms': baseline['Execution Time'], 'after_ms': indexed['Execution Time'],
            'before_filtered': filtered(baseline['Plan']), 'after_filtered': filtered(indexed['Plan']),
            'before_shared_hits': baseline['Plan']['Shared Hit Blocks'],
            'after_shared_hits': indexed['Plan']['Shared Hit Blocks'],
        }
        assert report['notice_idle_query']['after_filtered'] < 1000
    finally:
        transaction.rollback()
print(json.dumps(report, indent=2))
