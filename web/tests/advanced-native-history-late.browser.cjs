// Real native request + real PostgreSQL revision + real React/SSE. The only
// transport intervention delays an unchanged HTTP response to force ordering.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),APP='https://localhost:15473',CHART='https://127.0.0.1:15474';
const output=process.env.NATIVE_LATE_OUTPUT||path.join(root,'docs/verification/native-history/implementation/browser-late-revision.json');
const marker='/tmp/mw-provider-revision-'+process.pid+'.json';
const mode=process.env.NATIVE_LATE_MODE||'revision';
assert.ok(['revision','backfill'].includes(mode));
const evidence={kind:'native late history interleave; real provider bars and isolated PG revision',mode,
 background:'autonomous provider loops held by acceptance-only barrier entrypoint',passed:false,requests:[],responses:[],errors:[]};
const fixture=(action,start)=>JSON.parse(execFileSync('/home/quant/repos/market-watch/.venv/bin/python',[
 'scripts/provider_revision_fixture.py',action,'--native-history','--marker',marker,
 ...(start?['--start',String(start)]:[])],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')},timeout:45000}).toString());
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1400,height:900}});
 await context.addInitScript(()=>{
  globalThis.lateTrace=[];globalThis.lateEvents=[];
  addEventListener('message',e=>{if(e.data?.type==='provider-event')lateEvents.push(e.data.event)});
  addEventListener('DOMContentLoaded',()=>{
   if(!globalThis.TradingView?.widget)return;
   const Original=TradingView.widget;
   TradingView.widget=new Proxy(Original,{construct(target,args){
    const feed=args[0]?.datafeed;
    if(feed?.getBars){const get=feed.getBars;feed.getBars=function(s,r,p,cb,err){
     const t={symbol:s.ticker,resolution:r,params:{...p},start:performance.timeOrigin+performance.now()};lateTrace.push(t);
     return get.call(this,s,r,p,(bars,meta)=>{
      Object.assign(t,{callback:performance.timeOrigin+performance.now(),count:bars.length,first:bars[0]?.time,last:bars.at(-1)?.time,
       duplicates:bars.length-new Set(bars.map(b=>b.time)).size,bars});return cb(bars,meta);
     },e=>{t.error=String(e);return err(e)});
    };}return Reflect.construct(target,args,target);
   }});
  });
 });
 const password=JSON.parse(fs.readFileSync('/home/quant/repos/market-watch/artifacts/local-credentials.json')).password;
 const login=await context.request.post(APP+'/api/login',{data:{password}});assert.ok(login.ok());const csrf=(await login.json()).csrf;
 async function api(endpoint,body){const r=await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data:body,timeout:12000});assert.ok(r.ok());return r.json()}
 const page=await context.newPage();let frame,release,heldResolve,heldReject,holdNext=true,heldResponse;
 const held=new Promise((ok,fail)=>{heldResolve=ok;heldReject=fail});const released=new Promise(ok=>{release=ok});
 const jobs=[];
 page.on('pageerror',e=>evidence.errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('/api/charts/data'))evidence.requests.push({at:Date.now(),query:r.postDataJSON()})});
 page.on('response',r=>{if(!r.url().includes('/api/charts/data'))return;jobs.push((async()=>{
  const body=await r.json().catch(()=>({}));evidence.responses.push({at:Date.now(),status:r.status(),query:r.request().postDataJSON(),
   count:body.bars?.length,revision:body.cache_revision,as_of:body.as_of,revalidation:body.history_revalidation});
 })());});
 try{
  const w=await api('advanced-charts/workspaces',{name:'Late native isolated '+process.pid});
  await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',series_kind:'provider',interval:'5'}});
  await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
  frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady()&&!loading&&!historyReloading&&!rangeGuard.busy()&&!edgeGuard.busy()&&!pending.size,null,{timeout:22000});
  evidence.initial=await frame.evaluate(()=>({trace:lateTrace,range:widget.activeChart().getVisibleRange(),subscriptions:[...subscriptions.values()].map(s=>({listener:s.providerListener,res:s.res})),state:[...providerHistoryState]}));
  const oldest=Math.min(...evidence.initial.trace.filter(t=>t.count).map(t=>t.first))/1000;
  const target={from:oldest-100*300,to:oldest-5*300};evidence.target=target;
  await page.route('**/api/charts/data',async route=>{
   try{
    const query=route.request().postDataJSON();
    if(holdNext&&query.instrument==='BTCUSDT'&&!query.history_observation){
     holdNext=false;const response=await route.fetch({timeout:6500});heldResponse=await response.json();
     evidence.held={at:Date.now(),query,revision:heldResponse.cache_revision,as_of:heldResponse.as_of,count:heldResponse.bars?.length};heldResolve();
     await released;await route.fulfill({response});
    }else await route.continue();
   }catch(error){heldReject(error);await route.abort().catch(()=>{});}
  });
  evidence.action=Date.now();
  await frame.evaluate(target=>{globalThis.lateNavigation=widget.activeChart().setVisibleRange(target,{rejectByTimeout:20000}).catch(error=>{globalThis.lateNavigationError=String(error)})},target);
  let timer;
  try{await Promise.race([held,new Promise((_,fail)=>{timer=setTimeout(()=>fail(Error('no native response held within setup budget')),6500)})]);}finally{clearTimeout(timer)}
  assert.ok(heldResponse.bars?.length,'transport barrier must hold actual native response');
  await frame.evaluate(()=>{loading=true});
  const eventOffset=await frame.evaluate(()=>lateEvents.length);
  if(mode==='revision'){
   evidence.injection=fixture('revise',heldResponse.bars[Math.floor(heldResponse.bars.length/2)].start);
   await frame.waitForFunction(revision=>lateEvents.some(e=>e.type==='reset'&&e.revision>=revision),evidence.injection.revision,{timeout:Math.max(1,6500-(Date.now()-evidence.action))});
  }else{
   const snapshot=fixture('snapshot');
   evidence.backfill=await api('charts/data',{instrument:'BTCUSDT',series_kind:'provider',timeframe:'M5',before:snapshot.coverage[0][0],countBack:10});
   assert.ok(evidence.backfill.cache_revision>heldResponse.cache_revision,'real new older data must advance dataset revision');
   await frame.waitForFunction(({revision,offset})=>lateEvents.slice(offset).some(e=>e.type==='bars'&&e.revision>=revision),{revision:evidence.backfill.cache_revision,offset:eventOffset},{timeout:Math.max(1,6500-(Date.now()-evidence.action))});
  }
  evidence.release=Date.now();assert.ok(evidence.release-evidence.action<6500,'leave budget for one review');release();
  if(mode==='revision')await frame.waitForFunction(()=>[...providerHistoryWork.values()].some(w=>w.correction?.verified)&&[...providerHistoryWork.values()].every(w=>!w.inflight),null,{timeout:12000});
  else await frame.waitForFunction(()=>lateTrace.length===2&&lateTrace.at(-1).callback&&[...providerHistoryWork.values()].every(w=>!w.inflight&&!w.correction),null,{timeout:12000});
  await frame.evaluate(()=>{loading=false});
  await frame.waitForFunction(()=>widget.activeChart().dataReady()&&!loading&&!historyReloading&&![...providerHistoryWork.values()].some(w=>w.correction)&&!pending.size,null,{timeout:22000});
  await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
  evidence.final=await frame.evaluate(()=>({trace:lateTrace,range:widget.activeChart().getVisibleRange(),events:lateEvents,work:[...providerHistoryWork]}));
  await Promise.all(jobs);
  const reviews=evidence.responses.filter(r=>r.query.history_observation);
  assert.equal(reviews.length,1,'one automatic review for one delayed native response');
  assert.deepEqual(reviews[0].revalidation,{changed:mode==='revision'});
  assert.ok(evidence.final.trace.every(t=>t.callback&&!t.error&&!t.duplicates),'all valid native callbacks delivered');
  if(mode==='revision'){
   const revised=evidence.final.trace.flatMap(t=>t.bars||[]).filter(b=>b.time===evidence.injection.start);
   assert.equal(revised.at(-1)?.close,Number(evidence.injection.close),'native receives exact injected historical revision');
  }else{
   assert.ok(evidence.final.events.slice(eventOffset).every(e=>e.type!=='reset'),'pure older backfill emits no reset');
   assert.equal(evidence.final.trace.length,2,'pure backfill causes no extra native reload');
  }
  assert.ok(evidence.responses.every(r=>r.status===200));assert.deepEqual(evidence.errors,[]);
  await page.screenshot({path:output.replace('.json','.png')});evidence.passed=true;
 }catch(error){evidence.error=String(error);evidence.debug=await frame?.evaluate(()=>({trace:lateTrace,events:lateEvents,range:widget.activeChart().getVisibleRange(),loading,historyReloading,pending:pending.size,work:[...providerHistoryWork],navigationError:globalThis.lateNavigationError})).catch(()=>null);throw error}
 finally{release();if(fs.existsSync(marker))evidence.restoration=fixture('restore');await Promise.allSettled(jobs);fs.writeFileSync(output,JSON.stringify(evidence,null,2));await browser.close()}
})().catch(error=>{console.error(error.message);process.exitCode=1});
