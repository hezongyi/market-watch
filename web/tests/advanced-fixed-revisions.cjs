const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..');
const generated=spawnSync(path.join(repo,'.venv/bin/python'),
  [path.join(__dirname,'fixtures/fixed-series-revision-feed.py')],{
    cwd:repo,encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(repo,'backend')+':'+path.join(repo,'backend/tests'),
      ALERTS_DATABASE_URL:'sqlite://',ALERTS_DELIVERY_ENABLED:'false'}});
assert.equal(generated.status,0,generated.stderr);
const responses=JSON.parse(generated.stdout),events=[],queries=[];
const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
  location:{search:'?parent=http://localhost&marketPolling=1'},parent:{postMessage(){}},
  crypto:{randomUUID:()=> 'test'},addEventListener(){},setTimeout,clearTimeout,
  responses,events,queries});
for(const name of ['series.js','bridge.js'])
  vm.runInContext(fs.readFileSync(path.join(repo,'advanced-host',name),'utf8'),ctx);
(async()=>{
  await vm.runInContext(`(async()=>{
    ready=true;
    const chart={symbol:()=>responses.ticker.toUpperCase(),resolution:()=> '1',getAllStudies:()=>[],
      getTimeScale:()=>({rightOffset:()=>0}),resetData:()=>events.push('reload')};
    widget={chartsCount:()=>1,chart:()=>chart,resetCache:()=>events.push('widget-reset')};
    refreshChartHistory=async(widget,chart,invalidate,current)=>{
      if(!current())return false;invalidate();chart.resetData();return true;
    };
    request=async(q)=>{queries.push(q);return responses.initial};
    await feed.getBars({ticker:responses.ticker.toUpperCase()},'1',
      {to:200010,countBack:12,firstDataRequest:true},()=>{},error=>{throw Error(error)});
    feed.subscribeBars({ticker:responses.ticker.toUpperCase()},'1',()=>events.push('latest'),
      'pane',()=>events.push('cache-reset'));
    await tick();events.length=0;
    request=async(q)=>{queries.push(q);return responses.appended};await tick();
  })()`,ctx);
  assert.deepEqual(events,['latest','latest'],'Appending a confirmed minute must not reset loaded history');
  assert.equal(queries.at(-1).revision_after,responses.initial.bars[0].start,
    'Loaded-prefix review uses raw UTC starts even when native identity was uppercased');
  events.length=0;
  await vm.runInContext(`request=async(q)=>{queries.push(q);return responses.corrected};tick()`,ctx);
  assert.deepEqual(events,['cache-reset','reload'],
    'An older accepted input correction must reach the public native reset and redraw callbacks');
  console.log('Fixed composite input correction redraws native history; append preserves its cache');
})().catch(error=>{console.error(error);process.exitCode=1});
