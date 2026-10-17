import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path('/home/quant/repos/market-watch-issue74-20261017')
TASK = Path('/tmp/mw-issue74-20261017')
CLI = '/tmp/mw-issue74-npm-cache/_npx/945f35517ce0271a/node_modules/playwriter/dist/cli.js'
ENV = dict(os.environ, PLAYWRITER_LOG_FILE_PATH=str(TASK / 'playwriter-budget-relay.log'), PLAYWRITER_TELEMETRY='0')
SYMBOLS = {'history': 'MWH:03064D76-2C86-46B3-B206-3DD35E156DFC', 'managed': 'PARITY',
           'provider': 'MWP:BTCUSDT', 'composite': 'MWC:2bcbc81d8e0e33b2318774f24638e2327448c8d3ecae8d190915cb94b50f637b'}
LONG = 'MWH:0A58E126-2EC4-4EBF-9313-31CCCB39AAB5'
groups = []


def add(kind, name, params, *, operation='add', scenario='loaded-new-spec', initial=None, timeframe='1', symbol=None, rows=6000):
    phase = f'execution-v2b-{kind}-{name.lower().replace("_", "-")}-{operation}-{scenario}-{len(groups)+1}'
    specs = []
    for p in params:
        spec = {'params': p}
        if name == 'SUPERTREND_PINE_V1':
            spec['inputs'] = {k: p[k] for k in ['period', 'source', 'multiplier']}
            spec['inputs'].update(changeATR=p['atr_method'] == 'wilder', showsignals=True, highlighting=True)
        specs.append(spec)
    config = dict(phase=phase, scenario=scenario, operation=operation, kind=kind, symbol=symbol or SYMBOLS[kind],
                  indicator=name, prefixRows=rows, specs=specs)
    config.update(prewarm=True) if scenario == 'loaded-reusable' else config.update(knownUnused=True)
    if initial:
        config['initial'] = {'params': initial}
    groups.append({'symbol': config['symbol'], 'timeframe': timeframe, 'config': config})


for kind in ['history', 'managed', 'provider', 'composite']:
    add(kind, 'EMA', [{'period': i} for i in range(391, 421)])
    add(kind, 'BBANDS', [{'period': i, 'deviation': 2.71} for i in range(80, 110)])
    add(kind, 'MACD', [{'fast': i, 'slow': i+61, 'signal': 13} for i in range(43, 73)])
    add(kind, 'SWING_SR_V1', [{'high_strength': i, 'low_strength': i+3} for i in range(16, 46)], scenario='loaded-complex-spec')
    add(kind, 'SUPERTREND_PINE_V1', [{'period': i, 'source': 'hl2', 'multiplier': 2.7, 'atr_method': 'sma'} for i in range(71, 101)], scenario='loaded-complex-spec')
    add(kind, 'EMA', [{'period': i} for i in range(421, 451)], operation='edit', initial={'period': 21})
    add(kind, 'EMA', [{'period': i} for i in range(471, 501)], scenario='loaded-reusable')
    add(kind, 'EMA', [{'period': i} for i in range(471, 501)], operation='edit', initial={'period': 21}, scenario='loaded-reusable')
for name in ['SMA', 'RSI', 'ATR']:
    add('history', name, [{'period': i} for i in range(201, 231)])
add('history', 'STOCH', [{'k': i, 'smooth': 6, 'd': 9} for i in range(111, 141)])
add('history', 'LWMA', [{'period': i} for i in range(61, 91)], timeframe='60', rows=96)
add('history', 'EMA', [{'period': i} for i in range(451, 481)], scenario='long-origin', symbol=LONG, rows=20160)
add('history', 'SUPERTREND_PINE_V1', [{'period': i, 'source': 'hl2', 'multiplier': 2.71, 'atr_method': 'sma'} for i in range(101, 131)],
    scenario='long-complex-origin', symbol=LONG, rows=20160)

plan = TASK / 'execution-matrix-plan-v2b.json'
serialized = json.dumps(groups, indent=2) + '\n'
if plan.exists():
    assert plan.read_text() == serialized, 'do not mutate a predeclared matrix'
else:
    plan.write_text(serialized)
if '--plan-only' in sys.argv:
    print(f'predeclared {len(groups)} groups x 30, including two long-origin groups')
    raise SystemExit(0)


def cli(args, output):
    with output.open('x') as log:
        return subprocess.run(['node', CLI, '-s', '3', *args], cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)


results = []
for group in groups:
    config = group['config']
    phase = config['phase']
    evidence = TASK / f'latency-{phase}.json'
    if not evidence.exists():
        configfile = TASK / f'config-{phase}.json'
        if not configfile.exists():
            configfile.write_text(json.dumps(group))
        setup = f'''const group=JSON.parse(require('node:fs').readFileSync({json.dumps(str(configfile))},'utf8'));
state.latency=group.config;
await state.chart.evaluate(()=>widget.activeChart().getAllStudies().forEach(study=>widget.activeChart().removeEntity(study.id)));
await state.chart.evaluate(symbol=>new Promise(resolve=>{{const chart=widget.activeChart();if(chart.symbol()===symbol)resolve();else chart.setSymbol(symbol,resolve);}}),group.symbol);
await state.chart.evaluate(resolution=>new Promise(resolve=>{{const chart=widget.activeChart();if(chart.resolution()===resolution)resolve();else chart.setResolution(resolution,resolve);}}),group.timeframe);
await state.chart.evaluate(()=>new Promise(resolve=>{{if(widget.activeChart().dataReady(resolve))resolve();}}));
console.log({{phase:state.latency.phase,symbol:await state.chart.evaluate(()=>widget.activeChart().symbol())}});'''
        proc = cli(['--timeout', '30000', '-e', setup], TASK / f'{phase}-setup.log')
        if proc.returncode:
            print(json.dumps(dict(phase=phase, setupFailed=True)), flush=True)
            raise SystemExit(proc.returncode)
        proc = cli(['--timeout', '660000', '-f', 'web/tests/indicator-parity-latency.playwriter.js'], TASK / f'latency-{phase}.log')
        if not evidence.exists():
            print(json.dumps(dict(phase=phase, harnessFailed=True, exit=proc.returncode)), flush=True)
            raise SystemExit(proc.returncode or 1)
    x = json.loads(evidence.read_text())
    summary = dict(phase=phase, passed=x['passed'], failures=x['failures'], first=x['ms']['p95'], coverage=x['coverageMs']['p95'], canonical=x['canonicalMs']['p95'])
    results.append(summary)
    print(json.dumps(summary), flush=True)
    # Fixed single traversal, retaining every failed group; no performance retry.
    (TASK / 'execution-matrix-summary-v2b.json').write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(0 if all(item['passed'] for item in results) else 1)
