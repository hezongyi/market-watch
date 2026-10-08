const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const python = spawnSync(path.join(repo, '.venv/bin/python'),
  [path.join(__dirname, 'fixtures/managed-revision-feed.py')], {
    cwd: repo, encoding: 'utf8', env: {...process.env, PYTHONPATH: path.join(repo, 'backend'),
      ALERTS_DATABASE_URL: 'sqlite://', ALERTS_DELIVERY_ENABLED: 'false'},
  });
assert.equal(python.status, 0, python.stderr);
const responses = JSON.parse(python.stdout);
const events = [];
const ctx = vm.createContext({URL, URLSearchParams, Map, Set, Promise, Date, Intl, Error,
  location: {search: '?parent=http://localhost&marketPolling=1'}, parent: {postMessage() {}},
  crypto: {randomUUID: () => 'test'}, addEventListener() {}, setTimeout, clearTimeout,
  events, responses});
for (const name of ['series.js', 'bridge.js'])
  vm.runInContext(fs.readFileSync(path.join(repo, 'advanced-host', name), 'utf8'), ctx);
(async () => {
  await vm.runInContext(`(async()=>{
    ready=true;
    const chart={symbol:()=> 'BTCUSDT', resolution:()=> '1', getAllStudies:()=>[],
      getTimeScale:()=>({rightOffset:()=>0}), resetData:()=>events.push('reload')};
    widget={chartsCount:()=>1, chart:()=>chart, resetCache:()=>events.push('widget-reset')};
    refreshChartHistory=async(widget,chart,invalidate,current)=>{
      if(!current())return false; invalidate(); chart.resetData(); return true;
    };
    managedSessions.set('BTCUSDT|1',{start:responses.start, revision:1});
    firstHistory.set('BTCUSDT|1',responses.start);
    subscriptions.set('pane',{symbol:'BTCUSDT',res:'1',
      last:responses.initial.bars.at(-1).start,cb:()=>events.push('latest'),
      reset:()=>events.push('cache-reset')});
    query=async()=>responses.initial; await tick(); events.length=0;
    query=async()=>responses.expanded; await tick();
  })()`, ctx);
  assert.deepEqual(events, ['latest'], 'earlier expansion keeps the session and does not reset');
  events.length = 0;
  await vm.runInContext(`(async()=>{
    query=async()=>responses.corrected; await tick();
  })()`, ctx);
  assert.deepEqual(events, ['cache-reset', 'reload'], 'closed historical correction reloads through public callbacks');
  assert.equal(vm.runInContext("managedSessions.get('BTCUSDT|1').start", ctx), responses.start);
  console.log('Actual published API corrections reload managed charts; expansion preserves session bounds');
})().catch(error => {console.error(error); process.exitCode=1;});
