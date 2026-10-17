"""Expire only a captured synthetic snapshot in this task's isolated database."""
import json
import os
from pathlib import Path
import re
import subprocess

TASK=Path('/tmp/mw-issue74-20261017')
ROOT=Path('/home/quant/repos/market-watch-issue74-20261017')
CLI='/tmp/mw-issue74-npm-cache/_npx/945f35517ce0271a/node_modules/playwriter/dist/cli.js'
env=dict(os.environ,PLAYWRITER_LOG_FILE_PATH=str(TASK/'playwriter-budget-relay.log'),PLAYWRITER_TELEMETRY='0')

def cli(script):
    result=subprocess.run(['node',CLI,'-s','3','--timeout','45000','-f',str(TASK/script)],cwd=ROOT,env=env,text=True,capture_output=True)
    print(result.stdout,flush=True)
    if result.returncode:
        print(result.stderr,flush=True)
        raise SystemExit(result.returncode)

for period in range(141,144):
    if not (TASK/f'recovery-held-v4-{period}.json').exists():
        cli('recovery-begin-v4.playwriter.js')
    held=json.loads((TASK/f'recovery-held-v4-{period}.json').read_text())
    assert held['period']==period and held['kind']=='composite' and held['timeframe']=='M1'
    assert held['instrument'].lower()=='2bcbc81d8e0e33b2318774f24638e2327448c8d3ecae8d190915cb94b50f637b'
    assert re.fullmatch('[a-f0-9]{64}',held['token'])
    assert re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',held['revision'])
    sql=f"""WITH expired AS (
UPDATE market_display_snapshots SET expires_at=(extract(epoch from clock_timestamp())*1000)::bigint-1
WHERE id='{held['token']}' AND revision_id='{held['revision']}' AND timeframe='M1'
RETURNING id,revision_id,expires_at)
SELECT coalesce(json_agg(row_to_json(expired)),'[]'::json) FROM expired;"""
    result=subprocess.run(['docker','exec','-i','mw-issue74-20261017-pg-1','sh','-c',
        'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],input=sql,text=True,capture_output=True,check=True)
    expired=json.loads(result.stdout)
    assert len(expired)==1,'must touch only the captured task snapshot'
    (TASK/f'recovery-expiry-v4-{period}.json').write_text(json.dumps(expired,indent=2)+'\n')
    print(json.dumps({'expiredRows':len(expired),'period':period}),flush=True)
    cli('recovery-finish-v4.playwriter.js')
