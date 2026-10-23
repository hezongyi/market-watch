const {chromium}=require(require.resolve('playwright',{paths:[process.cwd()+'/web']}));
const fs=require('node:fs');
const crypto=require('node:crypto');
const base='https://192.168.7.232:18280';
const chartOrigin='https://192.168.7.232:18281';
const workspace='7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
const output=process.env.MW_DEEP_OUT||'/tmp/mwa-latency-deep-20261022/observed';
fs.mkdirSync(output,{recursive:true,mode:0o700});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const summary=w=>({id:w.id,revision:w.revision,hash:hash(JSON.stringify(w)),documentHash:hash(JSON.stringify(w.document))});
const hooks=String.raw`
// [MWLAT-20261022] Observation only. Original queue choices and promises remain unchanged.
globalThis.__MWLAT={records:[],next:0,byId:new Map(),byResolve:new WeakMap()};
{
 const d=globalThis.__MWLAT;
 const brief=(q,type)=>({type,op:q.op||'data',instrument:q.instrument||q.args?.instrument,
  series_kind:q.series_kind,timeframe:q.timeframe||q.args?.timeframe,
  indicators:q.indicators?.length||0,native:!!q.native_history,reserve:!!q.native_reserve,
  first:q.firstDataRequest,focused:q.native_history?.focused,countBack:q.countBack,limit:q.limit,
  before:q.before,from:q.from,background:q.background,progress_id:q.history_progress_id});
 const occupancy=()=>[...pending.entries()].map(([id,e])=>({id,qid:d.byId.get(id)?.qid,
  quote:!!e.quote,reserve:!!e.reserve,management:!!e.management,
  background:!!e.background,purpose:e.purpose,nativeHistory:!!e.nativeHistory}));
 const push=requests.push;
 requests.push=function(...entries){
  for(const e of entries){
   const row={qid:++d.next,enqueued:Date.now(),query:brief(e.query,e.type),
    purpose:e.scheduling?.purpose,queued_before:this.length,blockers:occupancy()};
   if(d.records.length<4000)d.records.push(row);
   const resolve=e.resolve,reject=e.reject;
   e.resolve=function(value){row.completed=Date.now();row.result={bars:value?.bars?.length,
    cache_hit:value?.cache_hit,timings_ms:value?.timings_ms,history_pages:value?.history_pages};return resolve(value);};
   e.reject=function(error){row.completed=Date.now();row.error_code=error?.code||error?.name;return reject(error);};
   d.byResolve.set(e.resolve,row);
  }
  return push.apply(this,entries);
 };
 const put=pending.set,remove=pending.delete;
 pending.set=function(id,e){
  const row=d.byResolve.get(e.resolve);
  if(row){row.id=id;row.dispatched=Date.now();row.dispatch_blockers=occupancy();
   row.queued_at_dispatch=requests.length;d.byId.set(id,row);}
  return put.call(this,id,e);
 };
 pending.delete=function(id){const row=d.byId.get(id);if(row)row.slot_released=Date.now();return remove.call(this,id);};
}
`;

(async()=>{
 const report={at:new Date().toISOString(),mode:'observation-only',trials:[],requests:[],blocked:[],errors:[]};
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:1000}});
 let host,page;
 const responses=new Set();
 const save=()=>fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2),{mode:0o600});
 await context.route('**/host.*.js',async route=>{
  const response=await route.fetch();
  const source=await response.text();
  const bridge=fs.readFileSync('advanced-host/bridge.js','utf8');
  report.host_asset_sha256=hash(source);
  report.bridge_sha256=hash(bridge);
  report.expected_bridge_sha256=process.env.MW_EXPECTED_BRIDGE_SHA256||hash(bridge);
  if(report.bridge_sha256!==report.expected_bridge_sha256||!source.includes(bridge)){
   report.bridgeMismatch=true;return route.abort('blockedbyclient');
  }
  const anchor='let initialHistoryGate;';
  if(source.split(anchor).length!==2)throw Error('Diagnostic anchor is not unique');
  await route.fulfill({response,body:source.replace(anchor,anchor+'\n'+hooks)});
 });
 const reads=new Set(['/api/login','/api/market-data/resolve','/api/charts/data','/api/charts/reserve',
  '/api/market-data/viewport-session','/api/market-data/history/cache','/api/market-data/history/demand',
  '/api/market-data/quotes','/api/charts/stream/subscribe','/api/charts/stream/unsubscribe','/api/charts/stream/accept']);
 await context.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(['GET','HEAD','OPTIONS'].includes(request.method())||reads.has(path)||
    path.startsWith('/api/charts/history-loads')||path.startsWith('/api/charts/indicator-demands/'))return route.continue();
  report.blocked.push({at:Date.now(),path,method:request.method()});
  if(path==='/api/advanced-charts/preferences/migrate')return route.fulfill({json:{ok:true}});
  return route.fulfill({status:409,json:{detail:'Read-only latency diagnosis'}});
 });
 const requestRows=new WeakMap();
 page=await context.newPage();
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('request',request=>{
  const url=new URL(request.url());
  if(!url.pathname.startsWith('/api/'))return;
  let raw;try{raw=request.postDataJSON();}catch{}
  const q=raw?.query||raw;
  const row={path:url.pathname,method:request.method(),at:Date.now()};
  if(q&&url.pathname!=='/api/login')row.query={instrument:q.instrument,series_kind:q.series_kind,
   timeframe:q.timeframe,countBack:q.countBack,limit:q.limit,from:q.from,before:q.before,
   first:q.firstDataRequest,indicators:q.indicators?.length,native_history:q.native_history};
  if(raw?.request_id)row.request_id=raw.request_id;
  requestRows.set(request,row);report.requests.push(row);
 });
 page.on('requestfailed',request=>{const row=requestRows.get(request);if(row){row.ended=Date.now();row.failure=request.failure()?.errorText;}});
 page.on('requestfinished',request=>{
  const row=requestRows.get(request);
  if(row){row.networkFinished=Date.now();row.networkTiming=request.timing();}
 });
 page.on('response',response=>{
  const row=requestRows.get(response.request());if(!row)return;
  const promise=(async()=>{
   row.headers=Date.now();row.status=response.status();
   if(['/api/charts/data','/api/charts/reserve'].includes(row.path)||row.path.startsWith('/api/charts/history-loads')){
    const body=await response.json().catch(()=>({}));
    if(body.load||body.state){const load=body.load||body;row.load={id:load.id,state:load.state,pages:load.pages,error_code:load.error?.code};}
    const result=body.result||body;
    row.result={bars:result.bars?.length,cache_hit:result.cache_hit,timings_ms:result.timings_ms,
     mandatory_count:result.mandatory_count,optional_count:result.optional_count,
     display_snapshot:!!result.display_snapshot_id,provider_snapshot:!!result.provider_snapshot_id};
   }
   row.ended=Date.now();
  })();responses.add(promise);promise.finally(()=>responses.delete(promise));
 });
 try{
  await page.goto(base+'/advanced-charts/'+workspace,{waitUntil:'domcontentloaded'});
  await page.locator('input[type=password]').fill(process.env.MW_ACCEPTANCE_PASSWORD);
  await page.locator('button.auth-submit').click();
  await page.locator('iframe').first().waitFor({timeout:30000});
  report.workspaceBefore=summary(await(await context.request.get(base+'/api/advanced-charts/workspaces/'+workspace)).json());
  for(let i=0;i<300;i++){host=page.frames().find(f=>f.url().startsWith(chartOrigin+'/'));if(host)break;await page.waitForTimeout(100);}
  if(!host)throw Error('Chart frame unavailable');
  await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:90000});
  const ui=host.childFrames()[0];
  await ui.locator('[data-symbol-full="MWP:EURUSD"]').waitFor({timeout:30000});
  const rows=await ui.locator('[data-symbol-full]').evaluateAll(es=>es.map(e=>e.dataset.symbolFull));
  report.rows=rows;
  report.hostScripts=await host.evaluate(()=>[...document.scripts].map(s=>s.src?new URL(s.src).pathname:null).filter(Boolean));
  const history=rows.find(s=>s.startsWith('MWH:'));
  const composite='MWC:8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb';
  if(!history||!rows.some(s=>s.toLowerCase()===composite.toLowerCase()))throw Error('Original watchlist prerequisite changed');
  report.initial=await host.evaluate(()=>({symbols:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),studies:widget.chart(i).getAllStudies().length})),hooks:!!globalThis.__MWLAT}));
  if(!report.initial.hooks)throw Error('Queue observation was not installed');
  await host.evaluate(()=>{
   window.__MWLAT.feed=[];
   window.__MWLAT.chartEvents=[];
   for(let index=0;index<widget.chartsCount();index++) {
    const chart=widget.chart(index);
    chart.onDataLoaded().subscribe(null,()=>window.__MWLAT.chartEvents.push({
     index,at:Date.now(),symbol:chart.symbol(),resolution:chart.resolution(),ready:chart.dataReady(),range:chart.getVisibleRange()}));
   }
   for(const method of ['resolveSymbol','getBars']){
    const original=feed[method];
    feed[method]=function(...args){
     const row={method,at:Date.now(),symbol:method==='getBars'?args[0]?.ticker:args[0],resolution:method==='getBars'?args[1]:undefined};
     if(method==='getBars')row.period={from:args[2]?.from,to:args[2]?.to,countBack:args[2]?.countBack,first:args[2]?.firstDataRequest};
     window.__MWLAT.feed.push(row);
     const position=method==='getBars'?3:1,callback=args[position],fail=args[position+1];
     args[position]=function(...values){
      row.completed=Date.now();row.bars=Array.isArray(values[0])?values[0].length:undefined;
      try{return callback(...values);}finally{row.callbackReturned=Date.now();}
     };
     if(typeof fail==='function')args[position+1]=function(error){row.failed=Date.now();row.error_code=error?.code||String(error).slice(0,100);return fail(error);};
     return original.apply(this,args);
    };
   }
  });
  const waitQuiet=async()=>{
   const start=Date.now();
   try{
    await host.waitForFunction(()=>{
     const all=Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).every(c=>c.dataReady());
     const quiet=all&&!loading&&!requests.length&&![...pending.values()].some(e=>!e.management&&!e.quote);
     if(!quiet){globalThis.__mwQuietSince=0;return false;}
     globalThis.__mwQuietSince ||= Date.now();
     return Date.now()-globalThis.__mwQuietSince>=600;
    },null,{timeout:25000,polling:100});
    return {quiet:true,wait_ms:Date.now()-start};
   }catch{return {quiet:false,wait_ms:Date.now()-start};}
  };
  for(const ticker of ['MWP:EURUSD',history,composite,'MWP:EURUSD']){
   const precondition=await waitQuiet();
   const trial={ticker,precondition,start:Date.now()};report.trials.push(trial);
   const row=ui.locator('[data-symbol-full="'+ticker+'"]').first();
   await row.click();trial.clicked=Date.now();
   try{
    await host.waitForFunction(t=>{try{const c=widget.activeChart();return c.symbol().toUpperCase()===t.toUpperCase()&&c.dataReady()&&!loading;}catch{return false;}},ticker,{timeout:45000});
    trial.active_ready=Date.now();
   }catch{trial.active_timeout=true;}
   try{
    await host.waitForFunction(t=>Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).every(c=>c.symbol().toUpperCase()===t.toUpperCase()&&c.dataReady()),ticker,{timeout:45000});
    trial.all_ready=Date.now();
   }catch{trial.all_timeout=true;}
   trial.slow=!!(trial.active_timeout||trial.all_timeout||(trial.active_ready-trial.start)>3000||(trial.all_ready-trial.start)>3000);
   trial.historyLoads=await page.evaluate(()=>window.MWHistoryLoadDiagnostics?.()||null);
   console.log(JSON.stringify({ticker,quiet:precondition.quiet,active_ms:trial.active_ready-trial.start,all_ms:trial.all_ready-trial.start,slow:trial.slow}));
   report.queue=await host.evaluate(()=>({records:__MWLAT.records,feed:__MWLAT.feed,chartEvents:__MWLAT.chartEvents}));save();
  }
  report.afterSettle=await waitQuiet();
  try {
   await page.waitForFunction(()=>{
    const state=window.MWHistoryLoadDiagnostics?.();
    return !state || state.admitted===0 && state.cleaning===0 && state.queued===0;
   },null,{timeout:15000});
  } catch { report.historyLoadsDidNotSettle=true; }
  report.historyLoads=await page.evaluate(()=>window.MWHistoryLoadDiagnostics?.()||null);
  report.queue=await host.evaluate(()=>({records:__MWLAT.records,feed:__MWLAT.feed,chartEvents:__MWLAT.chartEvents,remaining:requests.length,pending:pending.size}));
  report.workspaceAfter=summary(await(await context.request.get(base+'/api/advanced-charts/workspaces/'+workspace)).json());
  report.workspaceUnchanged=report.workspaceBefore.hash===report.workspaceAfter.hash;
 }catch(error){
  report.error=error.message;console.log('PROBE_ERROR',error.message);
  report.failureHistoryLoads=await page?.evaluate(()=>window.MWHistoryLoadDiagnostics?.()).catch(()=>null);
  report.failureQueue=await host?.evaluate(()=>({records:__MWLAT.records,feed:__MWLAT.feed,chartEvents:__MWLAT.chartEvents,
   queued:requests.length,pending:pending.size})).catch(()=>null);
 }
 finally{
  await Promise.allSettled([...responses]);
  save();await browser.close();
 }
 const invalid=report.error||report.workspaceUnchanged!==true||report.errors.length>0;
 const slow=report.trials.some(t=>t.slow||t.active_timeout||t.all_timeout);
 const failed=invalid||report.historyLoadsDidNotSettle||slow;
 const verdict=invalid?'PROBE_FAILED':report.historyLoadsDidNotSettle?'RESOURCE_NOT_SETTLED':slow?'SLOW_REPRODUCED':'NO_SLOW';
 console.log(JSON.stringify({verdict,error:report.error,workspaceUnchanged:report.workspaceUnchanged,records:report.queue?.records?.length,trials:report.trials.length}));
 if(failed)process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
