// Native historical navigation through the product React/postMessage chain.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),APP='https://localhost:15473',CHART='https://127.0.0.1:15474';
const OUT=process.env.NATIVE_JUMP_OUTPUT||path.join(root,'docs/verification/native-history/implementation/browser-jump.json');
const SCENES=process.env.NATIVE_JUMP_SCENES?.split(',')||['cold','pg'];
const report={kind:'real product native historical corridor and direct historical startup; real upstream; finite deadline failures kept',cases:[]};
const save=()=>fs.writeFileSync(OUT,JSON.stringify(report,null,2));
const docker=cmd=>execFileSync('sg',['docker','-c',cmd],{cwd:root,timeout:60000,stdio:['ignore','pipe','pipe']}).toString();
(async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1400,height:900}});
 await context.addInitScript(()=>{globalThis.jumpTrace=[];addEventListener('DOMContentLoaded',()=>{
  if(!globalThis.TradingView?.widget)return;const Original=TradingView.widget;TradingView.widget=new Proxy(Original,{construct(target,args){
   const feed=args[0]?.datafeed;if(feed?.getBars){const get=feed.getBars;feed.getBars=function(s,r,p,cb,err){const t={ticker:s.ticker,res:r,params:{...p},at:performance.timeOrigin+performance.now()};jumpTrace.push(t);
    return get.call(this,s,r,p,(bars,meta)=>{Object.assign(t,{callback:performance.timeOrigin+performance.now(),count:bars.length,first:bars[0]?.time,last:bars.at(-1)?.time,duplicates:bars.length-new Set(bars.map(b=>b.time)).size,invalidTo:bars.some(b=>b.time>=p.to*1000)});return cb(bars,meta)},e=>{t.error=String(e);return err(e)})};}
   return Reflect.construct(target,args,target);
  }});
 })});
 const password=JSON.parse(fs.readFileSync('/home/quant/repos/market-watch/artifacts/local-credentials.json')).password;
 const login=await context.request.post(APP+'/api/login',{data:{password}});assert.ok(login.ok());const csrf=(await login.json()).csrf;
 async function api(endpoint,body){const r=await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data:body,timeout:20000});assert.ok(r.ok());return r.json()}
 async function settle(frame){await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady()&&pending.size===0&&!requests.length&&!loading&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:22000});await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))))}
 const layouts=new Map();
 try{
 // Preparation captures an opaque layout through the real public save API.
 // It is separate from all measured cold/cache runs and has no fabricated state.
 for(const symbol of ['MWP:OANDA:AUD_CAD','MWP:BTCUSDT']){
  let page;const preparation={symbol};
  try{
   docker('docker cp scripts/native_history_prepare_cache.py market-watch-native-history-api-1:/tmp/native_history_prepare_cache.py');
   const prepared=JSON.parse(docker(`docker exec market-watch-native-history-api-1 python /tmp/native_history_prepare_cache.py ${symbol.slice(4)} --count 12000`));
   assert.ok(prepared.target_10000&&prepared.target_10165,'target must be 10000 actual native bars back');
   const target={from:prepared.target_10165/1000,to:prepared.target_10000/1000};
   const w=await api('advanced-charts/workspaces',{name:'Native jump layout preparation '+symbol});
   await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,document:{engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'5'}});
   page=await context.newPage();await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
   const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));await settle(frame);
   await frame.evaluate(target=>widget.activeChart().setVisibleRange(target,{rejectByTimeout:22000}),target);await settle(frame);
   const state=await frame.evaluate(()=>captureChartLayout(widget));assert.ok(state.charts?.length,'public native layout must contain charts');
   layouts.set(symbol,{target,state});Object.assign(preparation,{prepared,target,passed:true});
  }catch(error){preparation.error=error.message;}finally{await page?.close();(report.preparations ||= []).push(preparation);save();}
 }
 for(const symbol of ['MWP:OANDA:AUD_CAD','MWP:BTCUSDT'])for(const cache of SCENES)for(const startup of [false,true]){
  const layout=layouts.get(symbol),target=layout?.target;
  const item={symbol,cache,startup,target,http:[],errors:[],gestures:[]};let page,frame;const work=[];
  try{
   assert.ok(layout,'real historical layout preparation failed');
   execFileSync('/home/quant/repos/market-watch/.venv/bin/python',['scripts/native_history_acceptance_fixture.py','--reset'],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')},timeout:45000});
   if(cache==='pg'){
    docker('docker cp scripts/native_history_prepare_cache.py market-watch-native-history-api-1:/tmp/native_history_prepare_cache.py');
    item.preparation=docker(`docker exec market-watch-native-history-api-1 python /tmp/native_history_prepare_cache.py ${symbol.slice(4)} --count 12000`);
   }
   const w=await api('advanced-charts/workspaces',{name:`Native jump ${symbol}/${cache}/${startup}`});
   const document={engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'5',...(startup?{state:layout.state}:{})};
   await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,document});
   page=await context.newPage();page.on('pageerror',e=>item.errors.push(e.message));page.on('response',r=>{if(!r.url().includes('/api/charts/data'))return;work.push((async()=>{const body=await r.json().catch(()=>({}));item.http.push({at:Date.now(),status:r.status(),query:r.request().postDataJSON(),count:body.bars?.length,mandatory:body.mandatory_count,optional:body.optional_count,hit:body.cache_hit,attempts:body.candles_http_attempts,timings:body.timings_ms})})());});
   item.uiStart=Date.now();await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
   await settle(frame);
   if(startup){await frame.waitForFunction(target=>widget.activeChart().getVisibleRange()?.to<=target.to+86400&&widget.activeChart().dataReady()&&!rangeGuard?.busy()&&!edgeGuard?.busy(),target,{timeout:22000});await settle(frame);}
   if(!startup){item.jumpStart=Date.now();await frame.evaluate(target=>widget.activeChart().setVisibleRange(target),target);await settle(frame)}
   item.displayed=Date.now();item.view=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing(),trace:jumpTrace}));
   item.native_ms=item.displayed-Math.min(...item.view.trace.filter(t=>t.callback&&(startup||t.at>=item.jumpStart)).map(t=>t.at));
   // Confirm actual target navigation; a restored latest screen is not a jump.
   if(item.view.range.to>target.to+86400)throw Error('direct historical document did not open target');
   for(const [from,to] of [[220,760],[760,220],[760,220]]){
    for(const f of page.frames())await f.getByText('了解！',{exact:true}).click({timeout:80}).catch(()=>{});
    const before=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),requests:jumpTrace.length,
     loadedFirst:Math.min(...jumpTrace.filter(t=>t.count).map(t=>t.first))/1000}));
    const box=await page.locator('iframe').boundingBox();await page.mouse.move(box.x+from,box.y+260);await page.mouse.down();await page.mouse.move(box.x+to,box.y+260,{steps:20});await page.mouse.up();await settle(frame);
    const after=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),requests:jumpTrace.length}));
    item.gestures.push({before,after,newRequests:after.requests-before.requests,
     beyondLoadedHistory:after.range.from<before.loadedFirst});
   }
   item.trace=await frame.evaluate(()=>jumpTrace);assert.ok(item.trace.every(t=>!t.duplicates&&!t.invalidTo));
   assert.ok(item.gestures.some(g=>Math.abs(g.after.range.from-g.before.range.from)>300),'gestures must move actual viewport');
   assert.ok(item.gestures.every(g=>g.newRequests===0||g.beyondLoadedHistory),
    'inside delivered native history must not issue getBars; boundary crossing is allowed');
   await page.screenshot({path:OUT.replace('.json',`-${symbol.includes('OANDA')?'oanda':'binance'}-${cache}-${startup?'direct':'navigation'}.png`)});
  }catch(error){item.error=error.message;if(frame)item.trace=await frame.evaluate(()=>jumpTrace).catch(()=>[]);}
  finally{await Promise.allSettled(work);if((item.errors.length||item.http.some(h=>h.status!==200))&&!item.error)item.error='provider response failed';await page?.close();report.cases.push(item);save();console.log(JSON.stringify({symbol,cache,startup,error:item.error,counts:item.http.map(h=>h.count),N:item.http.map(h=>h.query.countBack),gestures:item.gestures.map(g=>g.newRequests)}))}
 }
 }finally{report.completed=new Date().toISOString();save();await browser.close()}
})().catch(error=>{report.error=error.message;save();console.error(error.message);process.exitCode=1});
