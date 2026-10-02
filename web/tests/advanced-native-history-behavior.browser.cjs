// Real product chain: gestures, native indicators, period lifecycle and multichart budgets.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),APP='https://localhost:15473',CHART='https://127.0.0.1:15474';
const OUT=process.env.NATIVE_BEHAVIOR_OUTPUT||path.join(root,'docs/verification/native-history/implementation/browser-behavior.json');
const report={kind:'formal product behavior; real provider native periods; no mock data or vendor edits',cases:[],errors:[]};
const save=()=>fs.writeFileSync(OUT,JSON.stringify(report,null,2));
const docker=cmd=>execFileSync('sg',['docker','-c',cmd],{cwd:root,timeout:60000,stdio:['ignore','pipe','pipe']}).toString();
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 await context.addInitScript(()=>{
  globalThis.historyTrace=[];globalThis.historyLongTasks=[];
  addEventListener('DOMContentLoaded',()=>{if(!globalThis.TradingView?.widget)return;
   const Original=TradingView.widget;TradingView.widget=new Proxy(Original,{construct(target,args){
    const feed=args[0]?.datafeed;if(feed?.getBars){const original=feed.getBars;feed.getBars=function(s,r,p,cb,err){
     const t={symbol:s.ticker,resolution:r,params:{...p},start:performance.timeOrigin+performance.now()};historyTrace.push(t);
     return original.call(this,s,r,p,(bars,meta)=>{Object.assign(t,{callback:performance.timeOrigin+performance.now(),count:bars.length,first:bars[0]?.time,last:bars.at(-1)?.time,duplicates:bars.length-new Set(bars.map(b=>b.time)).size});return cb(bars,meta)},e=>{t.error=String(e);return err(e)});
    };}return Reflect.construct(target,args,target);
   }});
  });
  if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(l=>{
   for(const e of l.getEntries())historyLongTasks.push({start:performance.timeOrigin+e.startTime,duration:e.duration});
  }).observe({type:'longtask',buffered:true});
 });
 const password=JSON.parse(fs.readFileSync('/home/quant/repos/market-watch/artifacts/local-credentials.json')).password;
 const login=await context.request.post(APP+'/api/login',{data:{password}});assert.ok(login.ok());const csrf=(await login.json()).csrf;
 async function api(endpoint,body){const r=await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data:body,timeout:20000});assert.ok(r.ok(),endpoint+' '+r.status());return r.json();}
 async function prepare(symbol,frame='M5',count=4000){
  docker('docker cp scripts/native_history_prepare_cache.py market-watch-native-history-api-1:/tmp/native_history_prepare_cache.py');
  return docker(`docker exec market-watch-native-history-api-1 python /tmp/native_history_prepare_cache.py ${symbol.slice(4)} --timeframe ${frame} --count ${count}`);
 }
 async function open(symbol,cpu=1){
  const w=await api('advanced-charts/workspaces',{name:'Native behavior '+symbol+' '+cpu});
  await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,document:{engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'5'}});
  const page=await context.newPage();const http=[];const errors=[];const work=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(!r.url().includes('/api/charts/data'))return;work.push((async()=>{const body=await r.json().catch(()=>({}));http.push({at:Date.now(),status:r.status(),query:r.request().postDataJSON(),count:body.bars?.length,mandatory:body.mandatory_count,optional:body.optional_count,hit:body.cache_hit,attempts:body.candles_http_attempts,bytes:(await r.body()).length})})());});
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
  await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor({timeout:30000});
  const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await settle(frame);
  return {page,frame,http,errors,cdp,work};
 }
 async function settle(frame){await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady()&&pending.size===0&&!requests.length&&!loading&&!historyReloading&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:45000});await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));}
 async function snapshot(frame){return frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing(),requests:historyTrace.length,ready:widget.activeChart().dataReady(),pending:pending.size,queue:requests.length}));}
 async function dismiss(page){for(const f of page.frames())await f.getByText('了解！',{exact:true}).click({timeout:100}).catch(()=>{});}
 async function drag(env,from,to,y){
  await dismiss(env.page);const before=await snapshot(env.frame);
  const element=await env.page.locator('iframe').boundingBox();
  await env.frame.evaluate(()=>{globalThis.dragIntervals=[];globalThis.dragRunning=true;let last=performance.now();function tick(t){if(!dragRunning)return;dragIntervals.push(t-last);last=t;requestAnimationFrame(tick)}requestAnimationFrame(tick)});
  await env.page.mouse.move(element.x+from,element.y+y);await env.page.mouse.down();await env.page.mouse.move(element.x+to,element.y+y,{steps:24});await env.page.mouse.up();
  await settle(env.frame);const after=await snapshot(env.frame);const intervals=await env.frame.evaluate(()=>{dragRunning=false;return dragIntervals});
  return {before,after,newRequests:after.requests-before.requests,intervals};
 }
 try{
  for(const symbol of ['MWP:OANDA:AUD_CAD','MWP:BTCUSDT']){
   await prepare(symbol);const env=await open(symbol);const item={symbol,kind:'single native buffer/MA/period switch',http:env.http,errors:env.errors};
   try{
    item.initial=await snapshot(env.frame);item.movements=[];
    for(const [from,to] of [[250,850],[850,250],[850,250]])item.movements.push(await drag(env,from,to,280));
    assert.ok(item.movements.some(m=>Math.abs(m.after.range.from-m.before.range.from)>300),'real gestures must move viewport');
    assert.ok(item.movements.every(m=>m.newRequests===0),'within loaded native history no getBars');
    item.ma=await env.frame.evaluate(()=>widget.activeChart().createStudy('Moving Average',false,false,{length:200}));
    await settle(env.frame);
    item.maTrace=await env.frame.evaluate(()=>historyTrace.map(t=>({...t})));
    for(const resolution of ['1','15','240','1D','1W','1M']){
     const began=Date.now(),offset=await env.frame.evaluate(()=>historyTrace.length);
     await env.frame.evaluate(res=>widget.activeChart().setResolution(res,{doNotActivateChart:true}),resolution);await settle(env.frame);
     (item.periods ||= []).push({resolution,elapsed:Date.now()-began,nativeRequests:await env.frame.evaluate(offset=>historyTrace.slice(offset),offset)});
    }
    item.rapid=await env.frame.evaluate(async()=>{
     const sequence=['1','5','1D','15','1W','30','240','1M','60','5','1D','1','30','1W','15','240','60','1M','5','1'];
     const attempts=[];for(const resolution of sequence){const start=Date.now();const offset=historyTrace.length;
      try{await widget.activeChart().setResolution(resolution,{doNotActivateChart:true});
       await new Promise((ok,fail)=>{const until=Date.now()+15000;const poll=()=>{if(widget.activeChart().dataReady()&&pending.size===0){requestAnimationFrame(()=>requestAnimationFrame(ok));return;}if(Date.now()>until){fail(Error('period did not settle'));return;}setTimeout(poll,10)};poll()});
       attempts.push({resolution,elapsed:Date.now()-start,trace:historyTrace.slice(offset)});
      }catch(error){attempts.push({resolution,error:String(error)})}}
     return attempts;
    });
    assert.equal(item.rapid.length,20);assert.ok(item.rapid.every(t=>!t.error));
    item.trace=await env.frame.evaluate(()=>historyTrace);assert.ok(item.trace.every(t=>!t.duplicates));
    await env.page.screenshot({path:OUT.replace('.json',`-${symbol.includes('OANDA')?'oanda':'binance'}.png`)});
   }catch(error){item.error=error.message;}
   finally{await Promise.allSettled(env.work);await env.page.close();report.cases.push(item);save();console.log(JSON.stringify({symbol,kind:item.kind,error:item.error,drags:item.movements?.map(x=>x.newRequests),periods:item.periods?.length,rapid:item.rapid?.length}));}
  }
  for(const cpu of [1,4])for(const count of [1,2,4,8]){
   const symbol='MWP:BTCUSDT';await prepare(symbol);const env=await open(symbol,cpu);const item={kind:'multichart',cpu,count,http:env.http,errors:env.errors};
   try{
    if(count>1)await env.frame.evaluate(count=>widget.setLayout(count===2?'2h':String(count)),count);
    await env.frame.waitForFunction(count=>widget.chartsCount()===count&&Array.from({length:count},(_,i)=>widget.chart(i).dataReady()).every(Boolean)&&pending.size===0&&!loading,count,{timeout:45000});
    item.charts=await env.frame.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),range:widget.chart(i).getVisibleRange(),spacing:widget.chart(i).getTimeScale().barSpacing()})));
    // Force one real native demand per matching sequence after layout context
    // changes, so backend's conservative budget is observed at current count.
    await env.frame.evaluate(()=>{widget.resetCache();for(let i=0;i<widget.chartsCount();i++)widget.chart(i).resetData()});await settle(env.frame);
    item.trace=await env.frame.evaluate(()=>historyTrace);item.longTasks=await env.frame.evaluate(()=>historyLongTasks);
    item.metrics=(await env.cdp.send('Performance.getMetrics')).metrics.filter(m=>['JSHeapUsedSize','JSHeapTotalSize','TaskDuration','ScriptDuration','LayoutDuration'].includes(m.name));
    item.drag=await drag(env,count===1?250:80,count===1?850:240,count>=4?160:280);
    assert.equal(item.drag.newRequests,0);
    assert.ok(item.trace.every(t=>!t.duplicates));
    await env.page.screenshot({path:OUT.replace('.json',`-${count}-cpu${cpu}.png`)});
   }catch(error){item.error=error.message;}
   finally{await Promise.allSettled(env.work);await env.page.close();report.cases.push(item);save();console.log(JSON.stringify({kind:item.kind,cpu,count,error:item.error,http:item.http.map(x=>({count:x.count,optional:x.optional,context:x.query.native_history})),drag:item.drag?.newRequests}));}
  }
 }finally{report.finished_at=new Date().toISOString();save();await browser.close()}
})().catch(error=>{report.error=error.message;save();console.error(error.message);process.exitCode=1});
