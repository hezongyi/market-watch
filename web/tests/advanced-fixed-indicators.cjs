const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..');
const generated=spawnSync(process.env.MARKET_WATCH_TEST_PYTHON || path.join(repo,'.venv/bin/python'),
  [path.join(__dirname,'fixtures/fixed-indicator-feed.py')],{cwd:repo,encoding:'utf8',
    env:{...process.env,PYTHONPATH:path.join(repo,'backend')+':'+path.join(repo,'backend/tests'),
      ALERTS_DATABASE_URL:'sqlite://',ALERTS_DELIVERY_ENABLED:'false'}});
assert.equal(generated.status,0,generated.stderr);
const responses=JSON.parse(generated.stdout),events=[],sent=[],handlers={};
const parent={postMessage:message=>sent.push(message)};
const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
  document:{createElement:()=>({}),head:{append(){}}},
  location:{search:'?parent=http://localhost'},parent,
  crypto:{randomUUID:()=> 'test'},addEventListener:(name,callback)=>handlers[name]=callback,setTimeout,clearTimeout,
  atob:s=>Buffer.from(s,'base64').toString('utf8'),btoa:s=>Buffer.from(s).toString('base64'),responses,events});
for(const name of ['series.js','price-format.js','chart-runtime.js'])vm.runInContext(fs.readFileSync(path.join(repo,'advanced-host',name),'utf8'),ctx);
(async()=>{
  await vm.runInContext(`(async()=>{
    ready=true;
    globalThis.ticker='MWPY_'+btoa(JSON.stringify({symbol:responses.ticker,spec:responses.spec,key:'value'}));
    const chart={symbol:()=>responses.ticker,resolution:()=> '1',getAllStudies:()=>[],
      getTimeScale:()=>({rightOffset:()=>0,width:()=>960,barSpacing:()=>6}),resetData:()=>events.push('reload')};
    widget={chartsCount:()=>1,chart:()=>chart,resetCache:()=>events.push('widget-reset')};
    chartUsesSymbol=()=>true;
    refreshChartHistory=async(widget,chart,invalidate,current)=>{
      if(!current())return false;invalidate();chart.resetData();
      await feed.getBars({ticker},'1',{to:4201,countBack:12,firstDataRequest:true},
        rows=>{globalThis.restored=rows},error=>{throw Error(error)});
      return true;
    };
    request=async()=>responses.pending;
    await feed.getBars({ticker},'1',{to:4201,countBack:12,firstDataRequest:true},
      (rows)=>{globalThis.initial=rows},error=>{throw Error(error)});
    feed.subscribeBars({ticker},'1',()=>events.push('latest'),'study',()=>events.push('cache-reset'));
    request=async()=>responses.ready;
  })()`,ctx);
  const registration=sent.filter(message=>message.type==='market-subscribe').at(-1).args;
  assert.equal(responses.event.type,'reset','real indicator completion publishes a recovery event');
  await handlers.message({source:parent,origin:'http://localhost',data:{channel:'mw-chart-v1',
    type:'market-event',event:{...responses.event,listener:registration.listener,generation:registration.generation}}});
  assert.ok(events.includes('cache-reset') && events.includes('reload'),
    'Indicator completion must refill native historical study values through SSE recovery');
  assert.ok(ctx.initial.every(row=>row.volume===0),'Pending values must stay missing, not fabricated');
  assert.ok(ctx.restored.some(row=>row.volume===1),'Recovered history accepts computed study values');
  console.log('Full-origin fixed indicator completion reaches native historical redraw');
})().catch(error=>{console.error(error);process.exitCode=1});
