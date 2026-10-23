"""Offline synthetic fixture and redacted real-MCP verification for Ubuntu R1.

Seed/drain run only inside the task API container. No supplier entry point or
foreground client lease is used. Secrets stay in the explicitly supplied file.
"""

import argparse
import json
import sys
from pathlib import Path

MARKER = 'verification:mcp-composite-indicators-20261023'


def write_json(path, value):
    path = Path(path)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    path.chmod(0o600)


def seed(private):
    import pytest
    from alerts.mcp.auth import issue
    from alerts.storage import MarketComposite, Preference, Session, now_ms
    from sqlalchemy import select

    sys.path.insert(0, '/fixtures/tests')
    from test_composite_aggregates import drain as aggregate
    from test_composite_chart import populated
    from test_series_access import alternate_revision

    with Session.begin() as db:
        marker = db.get(Preference, MARKER)
        if marker:
            assert (private / 'credentials.json').exists(), 'seed credential missing; preserve DB for review'
            print('existing fixture retained')
            return
        assert db.scalar(select(MarketComposite)) is None, 'refuse to seed a nonempty composite DB'
    with pytest.MonkeyPatch.context() as patch:
        ident, revision, seam = populated(Session, patch)
        aggregate(revision, 'M1')
        alternate = alternate_revision(Session, ident, revision)
        fixture = {'instrument': ident, 'revision': revision, 'alternate': alternate, 'seam': seam}
    with Session.begin() as db:
        db.add(Preference(key=MARKER, value=fixture))
    token = issue('composite-indicators-r1', ['market:read', 'analysis:read'], now_ms() + 7 * 86400000)
    write_json(private / 'credentials.json', {'token': token, **fixture})
    write_json(private / 'fixture.json', fixture)
    print('synthetic fixture seeded; credential written privately')


def drain(private):
    from alerts.fixed_indicators import indicator_tick
    from alerts.storage import FixedIndicatorRun, Session

    ids = json.loads((private / 'runs.json').read_text())
    fixture = json.loads((private / 'fixture.json').read_text())
    for ident in ids:
        with Session.begin() as db:
            run = db.get(FixedIndicatorRun, ident)
            assert run and run.revision_id == fixture['revision'], 'only task fixture runs may advance'
        for _ in range(100):
            if not indicator_tick(ident):
                break
        else:
            raise AssertionError('fixture job did not finish')
    print(f'advanced {len(ids)} fixture runs with existing indicator_tick')


def facts():
    from alerts.storage import MarketComposite, MarketDemand, Session
    from sqlalchemy import func, select

    with Session.begin() as db:
        return {'composites': sorted([row.id, row.active_revision_id]
                                     for row in db.scalars(select(MarketComposite))),
                'market_demand_count': db.scalar(select(func.count()).select_from(MarketDemand))}


def verify(private, base_url, phase, output):
    import httpx

    creds = json.loads((private / 'credentials.json').read_text())
    with httpx.Client(base_url=base_url, timeout=30, trust_env=False) as client:
        headers = {'Authorization': 'Bearer ' + creds['token'],
                   'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'}
        def rpc(method, params=None):
            response = client.post('/mcp', headers=headers,
                json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}})
            response.raise_for_status()
            result = response.json()
            assert 'error' not in result, result
            return result['result']
        rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                          'clientInfo': {'name': 'composite-r1', 'version': '1'}})
        tools = rpc('tools/list')['tools']
        # This token has only market:read + analysis:read; full registry is 31.
        assert len(tools) == 24
        assert all(t['annotations']['readOnlyHint'] for t in tools)
        tool = next(t for t in tools if t['name'] == 'indicators_calculate')
        assert 'composite' in tool['inputSchema']['properties']['series_kind']['enum']
        def call(**changes):
            query = {'instrument': creds['instrument'], 'series_kind': 'composite', 'timeframe': 'M1',
                     'limit': 20, 'indicators': [{'name': 'EMA', 'params': {'period': 2}},
                                               {'name': 'RSI', 'params': {'period': 2}}], **changes}
            result = rpc('tools/call', {'name': 'indicators_calculate', 'arguments': query})
            assert not result.get('isError'), result
            page = result['structuredContent']['page']
            assert page['revision_id'] == creds['revision'] and page['input_revision'] == 1
            assert page['history_checksum'] and page['bars']
            for item in page['indicators']:
                evidence = item['calculation']['input_evidence']
                for field in ('revision_id', 'input_revision', 'history_version_id'):
                    assert evidence[field] == page[field]
                assert {v['time'] for s in item['series'] for v in s['values']} <= {b['start'] for b in page['bars']}
            return result
        result = call()
        page = result['structuredContent']['page']
        if phase == 'cold':
            assert page['pending'] and all(not i['calculation']['visible_complete'] for i in page['indicators'])
            write_json(private / 'runs.json', [i['calculation']['run_id'] for i in page['indicators']])
        else:
            assert all(i['calculation']['visible_complete'] for i in page['indicators'])
            assert all(any(v['value'] is not None for s in i['series'] for v in s['values']) for i in page['indicators'])
            pinned = call(composite_revision_id=creds['revision'], input_revision=1)
            assert pinned['structuredContent']['page']['bars'] == page['bars']
            provisional = call(provisional=True)
            display = provisional['structuredContent']['page']
            assert display['display_snapshot_id']
            assert all(i['calculation']['input_evidence']['display_snapshot_id'] == display['display_snapshot_id']
                       for i in display['indicators'])
        # Tokens/headers are never included in evidence.
        write_json(output, {'phase': phase, 'tool_count': len(tools), 'tool': tool, 'result': result,
                            **({'provisional': provisional} if phase == 'ready' else {})})
        print(f'{phase} protocol verification passed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['seed', 'drain', 'facts', 'cold', 'ready'])
    parser.add_argument('--private', type=Path, default=Path('/private'))
    parser.add_argument('--base-url', default='http://127.0.0.1:18623')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.mode == 'seed':
        seed(args.private)
    elif args.mode == 'drain':
        drain(args.private)
    elif args.mode == 'facts':
        write_json(args.output or args.private / 'facts.json', facts())
    else:
        verify(args.private, args.base_url, args.mode, args.output or args.private / (args.mode + '.json'))


if __name__ == '__main__':
    main()
