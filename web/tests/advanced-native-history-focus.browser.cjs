// Real public multichart APIs and provider/PG responses; no synthetic bars.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),APP='https://localhost:15473',CHART='https://127.0.0.1:15474';
const output=path.join(root,'docs/verification/native-history/implementation/browser-focus.json');
const report={kind:'four independent native periods, explicit unfocused budget and shared-series focus',cases:[],errors:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
const docker=cmd=>execFileSync('sg',['docker','-c',cmd],{cwd:root,timeout:45000}).toString();
(async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 await context.addInitScript(()=>{
  globalThis.focusTrace=[];addEventListener('DOMContentLoaded',()=>{
   if(!globalThis.TradingView?.widget)return;const Original=TradingView.widget;
   TradingView.widget=new Proxy(Original,{construct(target,args){const feed=args[0]?.datafeed;
    if(feed?.getBars){const get=feed.getBars;feed.getBars=function(s,r,p,cb,err){const t={symbol:s.ticker,resolution:r,params:{...p},start:Date.now()};focusTrace.push(t);
     return get.call(this,s,r,p,(bars,meta)=>{Object.assign(t,{count:bars.length,duplicates:bars.length-new Set(bars.map(b=>b.time)).size});cb(bars,meta)},e=>{t.error=String(e);err(e)})};}
    return Reflect.construct(target,args,target);
   }});
  });
 });
 const password=JSON.parse(fs.readFileSync('/home/quant/repos/market-watch/artifacts/local-credentials.json')).password;
 const login=await context.request.post(APP+'/api/login',{data:{password}});assert.ok(login.ok());const csrf=(await login.json()).csrf;
 async function api(endpoint,body){const r=await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data:body,timeout:12000});assert.ok(r.ok());return r.json()}
 async function settle(frame){await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).dataReady()).every(Boolean)&&!loading&&!historyReloading&&!pending.size&&!requests.length&&!rangeGuard.busy()&&!edgeGuard.busy(),null,{timeout:22000});await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))))}
 try{
  docker('docker cp scripts/native_history_prepare_cache.py market-watch-native-history-api-1:/tmp/native_history_prepare_cache.py');
  report.preparation=[];
  for(const frame of ['M1','M5','M15','M30'])report.preparation.push({frame,result:JSON.parse(docker(`docker exec market-watch-native-history-api-1 python /tmp/native_history_prepare_cache.py BTCUSDT --timeframe ${frame} --count 2000`))});
  for(const cpu of [1,4]){
   const item={cpu,http:[],errors:[]};let page,frame;const jobs=[];
   try{
    const w=await api('advanced-charts/workspaces',{name:'Four native periods '+cpu+' '+process.pid});
    await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',series_kind:'provider',interval:'5'}});
    page=await context.newPage();page.on('pageerror',e=>item.errors.push(e.message));
    page.on('response',r=>{if(!r.url().includes('/api/charts/data'))return;jobs.push((async()=>{const body=await r.json().catch(()=>({}));item.http.push({at:Date.now(),status:r.status(),query:r.request().postDataJSON(),count:body.bars?.length,mandatory:body.mandatory_count,optional:body.optional_count,hit:body.cache_hit,bytes:(await r.body()).length})})());});
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
    await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));await settle(frame);
    await frame.evaluate(()=>{widget.dateRangeSync().setValue(false);widget.timeSync().setValue(false);widget.setLayout('4')});await settle(frame);
    await frame.evaluate(async()=>{for(const [index,res] of [[1,'15'],[2,'30'],[3,'1']])await widget.chart(index).setResolution(res,{doNotActivateChart:true})});await settle(frame);
    item.geometry=await frame.evaluate(()=>({active:widget.activeChartIndex(),charts:Array.from({length:4},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution()}))}));
    assert.equal(item.geometry.active,0);assert.equal(new Set(item.geometry.charts.map(c=>c.resolution)).size,4);
    const begin=Date.now();await frame.evaluate(()=>{widget.resetCache();for(let i=0;i<4;i++)widget.chart(i).resetData()});await settle(frame);await Promise.all(jobs);
    item.independent=item.http.filter(r=>r.at>=begin);assert.equal(new Set(item.independent.map(r=>r.query.timeframe)).size,4,'four independent responses');
    for(const r of item.independent){assert.equal(r.status,200);assert.equal(r.query.native_history.chart_count,4);const focused=r.query.timeframe==='M5';assert.equal(r.query.native_history.focused,focused);
     assert.ok(focused?r.optional>0&&r.optional<=1000:r.optional===0,'unfocused >=4 receives no optional bars');assert.ok(r.count>=r.query.countBack,'mandatory demand retained');}
    await frame.evaluate(()=>widget.chart(3).setResolution('5',{doNotActivateChart:true}));await settle(frame);
    const sharedStart=Date.now();await frame.evaluate(()=>{widget.resetCache();widget.chart(0).resetData();widget.chart(3).resetData()});await settle(frame);await Promise.all(jobs);
    item.shared=item.http.filter(r=>r.at>=sharedStart&&r.query.timeframe==='M5');assert.equal(item.shared.length,1,'matching native series shares a single getBars response');
    assert.equal(item.shared[0].query.native_history.focused,true);assert.ok(item.shared[0].optional>0&&item.shared[0].optional<=1000);
    item.trace=await frame.evaluate(()=>focusTrace);assert.ok(item.trace.every(t=>!t.error&&!t.duplicates));assert.deepEqual(item.errors,[]);
    await page.screenshot({path:output.replace('.json',`-cpu${cpu}.png`)});item.passed=true;
   }catch(error){item.error=String(error);}finally{await Promise.allSettled(jobs);await page?.close();report.cases.push(item);save()}
  }
 }finally{report.finished=new Date().toISOString();save();await browser.close()}
 assert.ok(report.cases.length===2&&report.cases.every(c=>c.passed),'focus acceptance failed');
})().catch(error=>{report.error=String(error);save();console.error(error.message);process.exitCode=1});
