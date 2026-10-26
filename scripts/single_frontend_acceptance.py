"""HTTP/MCP checks against an explicitly configured isolated R2 candidate."""
import argparse
import json
import uuid
from pathlib import Path

import httpx


def check(base_url, credentials):
    evidence = {'base_url': base_url, 'synthetic': True, 'checks': []}
    def passed(name):
        evidence['checks'].append(name)
    with httpx.Client(base_url=base_url, verify=credentials['ca_file'], timeout=30) as client:
        response = client.post('/api/login', json={'password': credentials['login_password']})
        response.raise_for_status()
        client.headers['x-csrf-token'] = response.json()['csrf']
        assert 'Secure' in response.headers['set-cookie'] and 'HttpOnly' in response.headers['set-cookie']
        passed('same-origin login with Secure HttpOnly session')
        manifest = client.get('/chart-assets.json').json()
        for path in ['/', '/settings/account', '/advanced-charts', '/'+manifest['script'],
                     '/'+manifest['libraryDirectory']+'/charting_library.js']:
            assert client.get(path).status_code == 200, path
        assert "frame-src 'self' blob:" in client.get('/').headers['content-security-policy']
        passed('one application entry and pinned same-origin chart resources')
        for path in ['/api/watches', '/api/replays', '/api/charts/workspaces']:
            assert client.post(path, json={}).status_code == 410, path
        passed('retired activities reject writes')
        def rpc(method, params=None, readonly=False):
            result = client.post('/mcp', headers={
                'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
                'Authorization': 'Bearer '+credentials['mcp']['read' if readonly else 'write']},
                json={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}})
            result.raise_for_status()
            return result.json()
        def call(name, arguments, readonly=False):
            return rpc('tools/call', {'name':name, 'arguments':arguments},readonly)['result']
        tools=rpc('tools/list')['result']['tools']
        names={row['name'] for row in tools}
        assert {'chart_alerts_list','chart_alerts_get','chart_alerts_create','chart_alerts_edit','chart_alerts_lifecycle','chart_alerts_events'} <= names
        assert not {'alerts_create','alerts_cancel','alerts_list'} & names
        passed('ChartAlert tools replace Watch tools')
        ident=str(uuid.uuid4())
        config={'name':'Synthetic R2 HTTP/MCP '+ident,'instrument':'EURUSD','source':'dukascopy',
                'timeframe':'M5','max_triggers':3,'condition':{'relation':'cross_up','right':{'kind':'constant','value':'10'}}}
        row=client.post('/api/chart-alerts',json={'request_id':ident,'config':config})
        row.raise_for_status()
        row=row.json()
        read=call('chart_alerts_get',{'alert_id':row['id']})['structuredContent']
        assert read['id']==row['id']
        arguments={'idempotency_key':ident,'request_id':ident+'-mcp','config':{**config,'name':'Synthetic R2 MCP '+ident}}
        first=call('chart_alerts_create',arguments)['structuredContent']
        assert call('chart_alerts_create',arguments)['structuredContent']['id']==first['id']
        assert client.get('/api/chart-alerts/'+first['id']).json()['id']==first['id']
        denied=call('chart_alerts_create',{**arguments,'idempotency_key':str(uuid.uuid4())},True)
        assert denied.get('isError')
        passed('HTTP/MCP mutual reads, idempotent creation, readonly write rejection')
        config={**read['config'],'name':'Synthetic R2 edited '+ident}
        edited=call('chart_alerts_edit',{'idempotency_key':ident+'-edit','alert_id':row['id'],'version':row['version'],'config':config})['structuredContent']
        assert client.get('/api/chart-alerts/'+row['id']).json()['version']==edited['version']
        paused=client.post('/api/chart-alerts/'+first['id']+'/lifecycle',json={'request_id':ident+'-pause','version':first['version'],
            'control_revision':first['control_revision'],'action':'pause'})
        paused.raise_for_status()
        assert call('chart_alerts_get',{'alert_id':first['id']})['structuredContent']['status']=='paused'
        passed('cross-adapter edit and lifecycle')
        # Close the extra synthetic rules so repeat acceptance stays bounded.
        for rule in (edited,paused.json()):
            result=client.post('/api/chart-alerts/'+rule['id']+'/lifecycle',json={'request_id':str(uuid.uuid4()),'version':rule['version'],
                'control_revision':rule['control_revision'],'action':'archive'})
            result.raise_for_status()
        health=client.get('/api/health/summary')
        if health.status_code==404:
            health=client.get('/api/health')
        health.raise_for_status()
        evidence['health_endpoint']=str(health.request.url).removeprefix(base_url)
        passed('business health available')
        client.post('/api/logout',json={}).raise_for_status()
        assert client.get('/api/chart-alerts').status_code==401
        passed('logout revokes business access')
    return evidence


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',required=True)
    parser.add_argument('--credentials-file',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    result=check(args.base_url,json.loads(args.credentials_file.read_text()))
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'passed':len(result['checks']),'output':str(args.output)}))
