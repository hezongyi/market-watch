// Formal React/postMessage acceptance; no data routing or synthetic provider bars.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const APP='https://localhost:15473',CHART='https://127.0.0.1:15474';
const root=path.resolve(__dirname,'../..'),python='/home/quant/repos/market-watch/.venv/bin/python';
const OUT=process.env.NATIVE_HISTORY_OUTPUT||path.join(root,'docs/verification/native-history/implementation/browser-performance.json');
const REPEATS=Number(process.env.NATIVE_HISTORY_REPEATS||10);
const CANDIDATES=process.env.NATIVE_HISTORY_CANDIDATES?JSON.parse(process.env.NATIVE_HISTORY_CANDIDATES):null;
const symbols=['MWP:OANDA:AUD_CAD','MWP:BTCUSDT'];
const report={kind:'formal React/postMessage/native getBars to rendered dataReady; real upstream and isolated PG',
 source:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),records:[],environment:{app:APP,chart:CHART,viewport:{width:1400,height:900},cpu:1},started_at:new Date().toISOString()};
const save=()=>fs.writeFileSync(OUT,JSON.stringify(report,null,2));
const fixture=(...args)=>execFileSync(python,[path.join(root,'scripts/native_history_acceptance_fixture.py'),...args],
 {cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')},timeout:45000,stdio:['ignore','pipe','pipe']});
function toggle(enabled,candidate){
 fixture('--buffer',enabled?'on':'off',...(candidate?['--cold-extra',String(candidate.cold),'--first-extra',String(candidate.hot)]:[]));
 execFileSync('sg',['docker','-c','docker compose --env-file /tmp/mw-native-history/compose.env -p market-watch-native-history -f compose.acceptance.yaml -f docs/verification/native-history/implementation/compose-native-history.yaml up -d --no-deps --force-recreate api'],
  {cwd:root,timeout:60000,stdio:['ignore','pipe','pipe']});
 execFileSync('sg',['docker','-c','docker exec market-watch-native-history-web-1 nginx -s reload'],{stdio:['ignore','pipe','pipe']});
 execFileSync('sg',['docker','-c','docker exec market-watch-native-history-tls-1 nginx -s reload'],{stdio:['ignore','pipe','pipe']});
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:report.environment.viewport});
 await context.addInitScript(()=>{
  globalThis.nativeHistoryTrace=[];globalThis.nativeHistoryLongTasks=[];
  addEventListener('DOMContentLoaded',()=>{
   if(!globalThis.TradingView?.widget)return;
   const Original=TradingView.widget;
   TradingView.widget=new Proxy(Original,{construct(target,args){
    const datafeed=args[0]?.datafeed;
    if(datafeed?.getBars){const original=datafeed.getBars;
     datafeed.getBars=function(s,r,p,cb,err){
      const record={ticker:s.ticker,res:r,params:{...p},start:performance.timeOrigin+performance.now()};
      nativeHistoryTrace.push(record);
      return original.call(this,s,r,p,(bars,meta)=>{
       record.callback=performance.timeOrigin+performance.now();record.count=bars.length;
       record.first=bars[0]?.time;record.last=bars.at(-1)?.time;record.noData=meta.noData;
       record.duplicates=bars.length-new Set(bars.map(b=>b.time)).size;return cb(bars,meta);
      },error=>{record.error=String(error);return err(error)});
     };
    }
    return Reflect.construct(target,args,target);
   }});
  });
  if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{
   for(const entry of list.getEntries())nativeHistoryLongTasks.push({start:performance.timeOrigin+entry.startTime,duration:entry.duration});
  }).observe({type:'longtask',buffered:true});
 });
 const password=JSON.parse(fs.readFileSync('/home/quant/repos/market-watch/artifacts/local-credentials.json')).password;
 let csrf;
 async function login(){
  for(let attempt=0;attempt<50;attempt++){
   const r=await context.request.post(APP+'/api/login',{data:{password}}).catch(()=>null);
   if(r?.ok()){csrf=(await r.json()).csrf;return;}
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw Error('isolated API did not become ready');
 }
 async function api(endpoint,body){const r=await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data:body,timeout:20000});
  if(!r.ok())throw Error(endpoint+' status '+r.status());return r.json();}
 async function measure(workspace,symbol,enabled,repeat,scenario,candidate){
  const sample={repeat,enabled,scenario,symbol,candidate,resolution:'5',http:[],errors:[]};
  const page=await context.newPage();const waits=[];const requestAt=new Map();
  page.on('pageerror',e=>sample.errors.push(e.message));
  page.on('request',r=>{if(r.url().includes('/api/charts/data'))requestAt.set(r,Date.now())});
  page.on('response',r=>{if(!r.url().includes('/api/charts/data'))return;
   const waiting=(async()=>{const body=await r.json().catch(()=>({}));sample.http.push({status:r.status(),query:r.request().postDataJSON(),start:requestAt.get(r.request()),
    bytes:Number(r.headers()['content-length']||0),bars:body.bars?.length,mandatory_count:body.mandatory_count,optional_count:body.optional_count,
    cache_hit:body.cache_hit,attempts:body.candles_http_attempts,timings_ms:body.timings_ms,boundary:body.history_boundary});})();waits.push(waiting);
  });
  let frame;
  sample.ui_start=Date.now();
  try{
   await page.goto(APP+'/advanced-charts',{timeout:20000});
   await page.frameLocator('iframe').locator('#chart').waitFor({timeout:20000});
   frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
   await frame.waitForFunction(()=>typeof widget!=='undefined'&&widget&&nativeHistoryTrace.some(t=>t.callback)&&widget.activeChart().dataReady(),null,{timeout:18000});
   await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
   const finished=await frame.evaluate(()=>performance.timeOrigin+performance.now());
   const state=await frame.evaluate(()=>({trace:nativeHistoryTrace,long_tasks:nativeHistoryLongTasks,
    range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing(),
    symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),heap:performance.memory?.usedJSHeapSize}));
   Object.assign(sample,state,{displayed:finished,ui_ms:finished-sample.ui_start,
    native_ms:state.trace[0]?finished-state.trace[0].start:null});
   if(state.symbol!==symbol||state.resolution!=='5')throw Error('wrong symbol/period');
   if(state.trace.some(t=>t.error||t.duplicates))throw Error('native error/duplicate chart time');
   await page.screenshot({path:OUT.replace(/\.json$/,`-${repeat}-${enabled?'on':'off'}-${scenario}-${symbol.includes('OANDA')?'oanda':'binance'}.png`)});
  }catch(error){sample.error=error.message.split('\n')[0];if(frame)sample.trace=await frame.evaluate(()=>nativeHistoryTrace).catch(()=>[]);}
  finally{await Promise.allSettled(waits);await page.close();report.records.push(sample);save();
   console.log(JSON.stringify({repeat,enabled,scenario,symbol,ui_ms:sample.ui_ms,native_ms:sample.native_ms,error:sample.error,http:sample.http.map(r=>({status:r.status,bars:r.bars,cache_hit:r.cache_hit,attempts:r.attempts?.length}))}));}
  return sample;
 }
 try{
  for(let repeat=0;repeat<REPEATS;repeat++)for(const configuration of (CANDIDATES?CANDIDATES.slice(repeat%CANDIDATES.length).concat(CANDIDATES.slice(0,repeat%CANDIDATES.length)):(repeat%2?[true,false]:[false,true]))){
   const candidate=CANDIDATES?configuration:null,enabled=CANDIDATES?true:configuration;
   toggle(enabled,candidate);await login();await new Promise(resolve=>setTimeout(resolve,1500));
   for(const symbol of symbols){
    fixture('--reset');
    const workspace=await api('advanced-charts/workspaces',{name:`Native buffer ${repeat}/${enabled}/${symbol}`});
    await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
     document:{engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'5'}});
    await measure(workspace,symbol,enabled,repeat,'cold',candidate);
    // Prepare 4000 real native-period PG bars using ordinary backend demand.
    // A new page/document guarantees warm metric is not native-held history.
    try{
     execFileSync('sg',['docker','-c','docker cp scripts/native_history_prepare_cache.py market-watch-native-history-api-1:/tmp/native_history_prepare_cache.py'],{cwd:root,stdio:['ignore','pipe','pipe']});
     const preparation=execFileSync('sg',['docker','-c',`docker exec market-watch-native-history-api-1 python /tmp/native_history_prepare_cache.py ${symbol.slice(4)}`],{cwd:root,timeout:45000,stdio:['ignore','pipe','pipe']}).toString();
     report.preparations ||= [];report.preparations.push({repeat,enabled,symbol,result:preparation.trim()});
     await measure(workspace,symbol,enabled,repeat,'pg',candidate);
    }catch(error){report.records.push({repeat,enabled,scenario:'pg',symbol,error:'preparation: '+error.message});save();console.log('PG PREPARATION FAILED',symbol,error.message);}
   }
  }
 }finally{report.finished_at=new Date().toISOString();save();await browser.close();}
})().catch(error=>{report.error=error.message;save();console.error(error.message);process.exitCode=1});
