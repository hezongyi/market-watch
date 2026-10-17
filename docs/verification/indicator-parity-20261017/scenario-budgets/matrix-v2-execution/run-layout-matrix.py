import json
import os
from pathlib import Path
import subprocess

ROOT = Path('/home/quant/repos/market-watch-issue74-20261017')
TASK = Path('/tmp/mw-issue74-20261017')
CLI = '/tmp/mw-issue74-npm-cache/_npx/945f35517ce0271a/node_modules/playwriter/dist/cli.js'
ENV = dict(os.environ, PLAYWRITER_LOG_FILE_PATH=str(TASK/'playwriter-budget-relay.log'), PLAYWRITER_TELEMETRY='0')
symbols = {'history':'MWH:03064D76-2C86-46B3-B206-3DD35E156DFC','managed':'PARITY','provider':'MWP:BTCUSDT',
           'composite':'MWC:2bcbc81d8e0e33b2318774f24638e2327448c8d3ecae8d190915cb94b50f637b'}
studies = [{'name':'EMA','params':{'period':500}}, {'name':'BBANDS','params':{'period':20,'deviation':2}},
           {'name':'MACD','params':{'fast':12,'slow':26,'signal':9}},
           {'name':'SUPERTREND_PINE_V1','params':{'period':10,'source':'hl2','multiplier':3,'atr_method':'wilder'},
            'inputs':{'period':10,'source':'hl2','multiplier':3,'changeATR':True,'showsignals':True,'highlighting':True}}]
groups = [dict(phase=f'execution-v2b-layout-{kind}-{scenario}', scenario=scenario, kind=kind, symbol=symbol,
               studies=studies,count=30) for kind,symbol in symbols.items() for scenario in ['warm-layout','cold-local']]
plan = TASK/'layout-matrix-plan-v2b.json'
serialized=json.dumps(groups,indent=2)+'\n'
if plan.exists():
    assert plan.read_text()==serialized,'keep declared groups immutable'
else:
    plan.write_text(serialized)


def cli(arguments,log):
    with log.open('x') as output:
        result=subprocess.run(['node',CLI,'-s','3',*arguments],cwd=ROOT,env=ENV,stdout=output,stderr=subprocess.STDOUT)
    return result


results=[]
for config in groups:
    phase=config['phase']
    evidence=TASK/f'latency-{phase}.json'
    if not evidence.exists():
        if config['scenario']=='warm-layout':
            setup=f'''state.layout={json.dumps(config)};
await state.app.reload({{waitUntil:'domcontentloaded'}});
await state.app.locator('iframe[title="专业图表工作区"]').waitFor();
state.chart=state.app.frames().find(frame=>frame.url().startsWith('https://127.0.0.1:17475/'));
await state.chart.waitForFunction(()=>{{try{{return typeof widget!=='undefined' && widget.activeChart() && widget.activeChart().getVisibleRange();}}catch{{return false;}}}});
await state.chart.evaluate(()=>widget.activeChart().getAllStudies().forEach(study=>widget.activeChart().removeEntity(study.id)));
await state.chart.evaluate(symbol=>new Promise(resolve=>{{const chart=widget.activeChart();if(chart.symbol().toUpperCase()===symbol.toUpperCase())resolve();else chart.setSymbol(symbol,resolve);}}),state.layout.symbol);
await state.chart.evaluate(()=>new Promise(resolve=>{{const chart=widget.activeChart();if(chart.resolution()==='1')resolve();else chart.setResolution('1',resolve);}}));
await state.chart.evaluate(()=>new Promise(resolve=>{{if(widget.activeChart().dataReady(resolve))resolve();}}));
console.log({{phase:state.layout.phase,symbol:await state.chart.evaluate(()=>widget.activeChart().symbol())}});'''
            proc=cli(['--timeout','60000','-e',setup],TASK/f'{phase}-setup.log')
            if proc.returncode:
                raise SystemExit(f'setup failed for {phase}')
            proc=cli(['--timeout','180000','-f','web/tests/indicator-parity-layout-prepare.playwriter.js'],TASK/f'{phase}-prepare.log')
            if proc.returncode:
                raise SystemExit(f'preparation failed for {phase}')
            provenance=f'''require('node:fs').writeFileSync({json.dumps(str(TASK/f'{phase}-provenance.json'))},JSON.stringify({{config:state.layout,provenance:state.layoutProvenance}},null,2),{{flag:'wx'}});'''
            proc=cli(['--timeout','20000','-e',provenance],TASK/f'{phase}-provenance.log')
            if proc.returncode:
                raise SystemExit(f'provenance capture failed for {phase}')
        else:
            # This immediately follows the same kind's real saved warm layout.
            setup=f'''state.layout={{...state.layout,...{json.dumps(config)}}};console.log({{phase:state.layout.phase,saved:state.layout.saved}});'''
            proc=cli(['--timeout','20000','-e',setup],TASK/f'{phase}-setup.log')
            if proc.returncode:
                raise SystemExit(f'cold declaration failed for {phase}')
        proc=cli(['--timeout','360000','-f','web/tests/indicator-parity-layout.playwriter.js'],TASK/f'latency-{phase}.log')
        if not evidence.exists():
            raise SystemExit(f'harness failed before evidence: {phase}')
    value=json.loads(evidence.read_text())
    summary=dict(phase=phase,passed=value['passed'],failures=value['failures'],first=value['firstMs']['p95'],
                 coverage=value['coverageMs']['p95'],canonical=value['canonicalMs']['p95'])
    results.append(summary)
    (TASK/'layout-matrix-summary-v2b.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(summary),flush=True)
raise SystemExit(0 if all(item['passed'] for item in results) else 1)
