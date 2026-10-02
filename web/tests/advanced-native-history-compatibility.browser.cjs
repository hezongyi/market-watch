// Run separately with actual pinned old/new image combinations on this task's
// isolated compose environment. Compatibility is not a latency gate.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),APP='https://localhost:15473',CHART='https://127.0.0.1:15474';
const combination=process.env.NATIVE_COMPAT_COMBINATION;
assert.ok(['new-front-old-api','old-front-new-api','new-front-new-api'].includes(combination));
const output=path.join(root,`docs/verification/native-history/implementation/browser-${combination}.json`);
const report={combination,cases:[]};const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
(async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1400,height:900}});
 await context.addInitScript(()=>{globalThis.compatTrace=[];addEventListener('DOMContentLoaded',()=>{
  if(!globalThis.TradingView?.widget)return;const Original=TradingView.widget;
  TradingView.widget=new Proxy(Original,{construct(target,args){const feed=args[0]?.datafeed;
    if(feed?.getBars){const get=feed.getBars;feed.getBars=function(s,r,p,cb,err){const t={symbol:s.ticker,resolution:r,params:{...p},start:performance.timeOrigin+performance.now()};compatTrace.push(t);
    return get.call(this,s,r,p,(bars,meta)=>{Object.assign(t,{count:bars.length,duplicates:bars.length-new Set(bars.map(b=>b.time)).size});cb(bars,meta)},e=>{t.error=String(e);err(e)})};}
   return Reflect.construct(target,args,target);
  }});
 })});
 const password=JSON.parse(fs.readFileSync('/home/quant/repos/market-watch/artifacts/local-credentials.json')).password;
 const login=await context.request.post(APP+'/api/login',{data:{password}});assert.ok(login.ok());const csrf=(await login.json()).csrf;
 async function api(endpoint,body){const r=await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data:body,timeout:12000});assert.ok(r.ok());return r.json()}
 try{
  for(const symbol of ['MWP:BTCUSDT','MWP:OANDA:AUD_CAD']){
   const item={symbol,http:[],errors:[]},jobs=[];let page,frame;
   try{
    const w=await api('advanced-charts/workspaces',{name:combination+' '+symbol+' '+process.pid});
    await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,document:{engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'5'}});
    page=await context.newPage();page.on('pageerror',e=>item.errors.push(e.message));
    page.on('response',r=>{if(!r.url().includes('/api/charts/data'))return;jobs.push((async()=>{const body=await r.json().catch(()=>({}));item.http.push({status:r.status(),query:r.request().postDataJSON(),count:body.bars?.length,mandatory:body.mandatory_count,optional:body.optional_count,cache_hit:body.cache_hit,revalidation:body.history_revalidation})})());});
    await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
    assert.ok(frame,'old/new web must use only this task chart origin');
    await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady()&&!loading&&!pending.size&&!requests.length,null,{timeout:22000});
    await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));await Promise.all(jobs);
    item.trace=await frame.evaluate(()=>compatTrace);item.displayed=await frame.evaluate(()=>performance.timeOrigin+performance.now());item.native_ms=item.displayed-item.trace[0]?.start;
    assert.ok(item.trace.length&&item.trace.every(t=>t.count>=t.params.countBack&&!t.duplicates&&!t.error),'native demand must be complete');
    assert.ok(item.http.length&&item.http.every(r=>r.status===200));
    for(const r of item.http){
     assert.equal(!!r.query.native_history,combination!=='old-front-new-api');
     if(combination==='new-front-new-api'){
      assert.ok(r.mandatory>=r.query.countBack);assert.equal(r.count,r.mandatory+r.optional);
      assert.ok(r.optional>=0&&r.optional<=(r.cache_hit?2000:400));
     }else{assert.equal(r.count,r.query.countBack);assert.equal(r.mandatory,undefined,'legacy demand path is selected');assert.equal(r.optional,undefined);}
    }
    assert.deepEqual(item.errors,[]);await page.screenshot({path:output.replace('.json',`-${symbol.includes('OANDA')?'oanda':'binance'}.png`)});item.passed=true;
   }catch(error){item.error=String(error);}finally{await Promise.allSettled(jobs);await page?.close();report.cases.push(item);save()}
  }
 }finally{report.finished=new Date().toISOString();save();await browser.close()}
 assert.ok(report.cases.length===2&&report.cases.every(c=>c.passed),'runtime compatibility acceptance failed');
})().catch(error=>{report.error=String(error);save();console.error(error.message);process.exitCode=1});
