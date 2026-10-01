// Real providers, native library and isolated local acceptance. No routed data.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
const frames=['1','5','15','30','60','240','1D','1W','1M'];
const samples=process.env.FIRST_SCREEN_SAMPLES ? JSON.parse(process.env.FIRST_SCREEN_SAMPLES) :
 ['MWP:OANDA:AUD_CAD','MWP:BTCUSDT'].flatMap(symbol=>frames.map(resolution=>({symbol,resolution})));
const output=process.env.FIRST_SCREEN_OUTPUT||'/tmp/mw-provider-first-screen.json';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args:process.env.FIRST_SCREEN_CERT_SPKI ? ['--ignore-certificate-errors-spki-list='+process.env.FIRST_SCREEN_CERT_SPKI] : []});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 if(['1','public'].includes(process.env.FIRST_SCREEN_BOOT_TRACE)){
  await page.addInitScript(()=>{
   globalThis.bootTrace=[];globalThis.bootLongTasks=[];
   addEventListener('DOMContentLoaded',()=>{
    bootTrace.push({name:'dom-ready',at:performance.now()});
    // Observe public calls without routing resources (routing disables HTTP cache).
    if(globalThis.TradingView?.widget){
     const Original=TradingView.widget;
     TradingView.widget=new Proxy(Original,{construct(target,args){
      bootTrace.push({name:'widget-constructor',at:performance.now()});
      const feed=args[0]?.datafeed;
      for(const name of ['onReady','resolveSymbol','getBars'])if(typeof feed?.[name]==='function'){
       const method=feed[name];feed[name]=function(...values){
        bootTrace.push({name,at:performance.now()});
        const index={onReady:0,resolveSymbol:1,getBars:3}[name];
        if(typeof values[index]==='function'){
         const callback=values[index];
         values[index]=function(...result){
          bootTrace.push({name:name+'-callback',at:performance.now()});
          return Reflect.apply(callback,this,result);
         };
        }
        return Reflect.apply(method,this,values);
       };
      }
      const instance=Reflect.construct(target,args,target);
      bootTrace.push({name:'widget-constructor-return',at:performance.now()});
      instance.onChartReady(()=>bootTrace.push({name:'widget-ready',at:performance.now()}));
      return instance;
     }});
    }
   });
   addEventListener('message',e=>{
    if(e.data?.channel==='mw-chart-v1')bootTrace.push({name:'message-'+e.data.type,op:e.data.query?.op,at:performance.now()});
   });
   if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{
    for(const entry of list.getEntries())bootLongTasks.push({at:entry.startTime,duration:entry.duration});
   }).observe({type:'longtask',buffered:true});
  });
  if(process.env.FIRST_SCREEN_BOOT_TRACE==='1')await page.route(CHART+'/{bridge,host.*}.js',async route=>{
   const response=await route.fetch();let source=await response.text();
   source=source.replace('widget = new TradingView.widget({','bootTrace.push({name:"widget-constructor",at:performance.now()});widget = new TradingView.widget({')
    .replace('widget.onChartReady(async () => {','bootTrace.push({name:"widget-constructor-return",at:performance.now()});widget.onChartReady(async () => {bootTrace.push({name:"widget-ready",at:performance.now()});')
    .replace('getBars: async (s, res, p, cb, err) => {','getBars: async (s, res, p, cb, err) => {bootTrace.push({name:"getBars",at:performance.now()});');
   await route.fulfill({response,body:source});
  });
 }
 const errors=[],measurements=[],requests=[],starts=new Map();let began=0;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('/api/charts/data'))starts.set(r,Date.now());});
 page.on('response',async r=>{
  const start=starts.get(r.request());if(!start)return;
  const body=await r.json().catch(()=>({}));
  requests.push({query:r.request().postDataJSON(),status:r.status(),at_ms:start-began,
   elapsed_ms:Date.now()-start,count:body.bars?.length,as_of:body.as_of,boundary:body.history_boundary,cache_hit:body.cache_hit,timings_ms:body.timings_ms});
 });
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  for(const sample of samples){
   await page.goto(APP+'/');
   if(process.env.FIRST_SCREEN_RESET_CACHE==='1')
    execFileSync('../.venv/bin/python',['../scripts/provider_acceptance_fixture.py','--reset'],
      {env:{...process.env,PYTHONPATH:'../backend'},timeout:45000});
   const before=await api('advanced-charts/native-charts');
   const workspace=await api('advanced-charts/workspaces',{name:'平台首屏 '+sample.symbol+' '+sample.resolution});
   await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
    document:{engine:'tv31',schemaVersion:1,symbol:sample.symbol,series_kind:'provider',interval:sample.resolution}});
   const requestOffset=requests.length;began=Date.now();await page.goto(APP+'/advanced-charts');
   await page.frameLocator('iframe').locator('#chart').waitFor({timeout:60000});
   const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
   await frame.waitForFunction(()=>typeof widget!=='undefined'&&widget!=null,null,{timeout:60000});
   await frame.evaluate(()=>new Promise(ok=>widget.onChartReady(ok)));
   await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
   await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
   const displayed=Date.now()-began;
   await frame.waitForFunction(()=>ready&&widget.activeChart().dataReady(),null,{timeout:60000});
   const initialized=Date.now()-began;
   const state=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),
    range:widget.activeChart().getVisibleRange(),geometry:datasetGeometry(widget.activeChart().symbol(),widget.activeChart().resolution())}));
   assert.equal(state.symbol,sample.symbol);assert.equal(state.resolution,sample.resolution);assert.ok(state.range.to>state.range.from);
   const pages=requests.slice(requestOffset).filter(r=>r.query.instrument===sample.symbol.slice(4)&&!r.query.indicators?.length);
   const screenBars=Math.ceil(state.geometry.plot_width/state.geometry.bar_spacing);
   const record={...sample,began_ms:began,displayed_ms:displayed,initialized_ms:initialized,screen_bars:screenBars,pages,...state};
   if(['1','public'].includes(process.env.FIRST_SCREEN_BOOT_TRACE))record.boot=await Promise.all(page.frames().map(async f=>({
    url:f.url(),performance:await f.evaluate(()=>({time_origin:performance.timeOrigin,marks:bootTrace,long_tasks:bootLongTasks,
      navigation:performance.getEntriesByType('navigation').map(e=>e.toJSON()),
      resources:performance.getEntriesByType('resource').map(e=>({name:e.name,start:e.startTime,duration:e.duration,transfer:e.transferSize,size:e.decodedBodySize}))})).catch(()=>undefined)
   })));
   if(process.env.FIRST_SCREEN_TRACE==='1') record.resources=await Promise.all(page.frames().map(async f=>({
    url:f.url(),timing:await f.evaluate(()=>performance.getEntriesByType('resource').map(e=>({
     name:e.name,start:e.startTime,duration:e.duration,size:e.transferSize,type:e.initiatorType
    })).sort((a,b)=>b.duration-a.duration).slice(0,15)).catch(()=>[])
   })));
   measurements.push(record);fs.writeFileSync(output,JSON.stringify({passed:false,measurements,errors},null,2));console.log('SAMPLE',JSON.stringify(record));
   await frame.waitForFunction(()=>!loading&&!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy());
   await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
   const after=await api('advanced-charts/native-charts');
   assert.equal(after.length,before.length+1,'bootstrap/save must bind the existing workspace, never create a duplicate');
   assert.ok(after.some(row=>row.id===workspace.id&&row.name===workspace.name));
   if(process.env.FIRST_SCREEN_CHECK_WARM==='1'){
    // A fresh native document cannot reuse its previous period cache. Backend
    // cache timing starts when getBars asks, separately from document boot.
    const warmCount=pages[0].query.countBack+32;
    await api('charts/data',{...pages[0].query,before:undefined,countBack:warmCount,limit:warmCount});
    const warmOffset=requests.length;began=Date.now();await page.reload();
    await page.frameLocator('iframe').locator('#chart').waitFor({timeout:60000});
    const warmed=page.frames().find(f=>f.url().startsWith(CHART+'/'));
    await warmed.waitForFunction(()=>typeof widget!=='undefined'&&widget!=null,null,{timeout:60000});
    await warmed.evaluate(()=>new Promise(ok=>widget.onChartReady(ok)));
    await warmed.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
    await warmed.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
    const warmDisplay=Date.now()-began;
    const warmPages=requests.slice(warmOffset).filter(r=>r.query.instrument===sample.symbol.slice(4)&&!r.query.indicators?.length&&r.at_ms>=0);
    assert.ok(warmPages.length&&warmPages.every(p=>p.status===200));
    record.warm={navigation_ms:warmDisplay,request_to_display_ms:warmDisplay-warmPages[0].at_ms,pages:warmPages};
    fs.writeFileSync(output,JSON.stringify({passed:false,measurements,errors},null,2));
    assert.equal(warmPages[0].cache_hit,true,'new native document must consume the fresh persistent cache');
    assert.ok(record.warm.request_to_display_ms<1000,`${sample.symbol}/${sample.resolution} cached demand to display ${record.warm.request_to_display_ms}ms exceeds 1s`);
   }
  }
  assert.deepEqual(errors,[]);
  for(const sample of measurements){
   assert.ok(sample.pages.length&&sample.pages.every(p=>p.status===200));
   if(process.env.FIRST_SCREEN_RESET_CACHE==='1') {
    assert.ok(sample.pages[0].as_of>=sample.began_ms, 'cold sample must receive a newly acquired provider page');
    assert.equal(sample.pages[0].cache_hit,false);
   }
   assert.equal(sample.pages[0].query.limit,sample.pages[0].query.countBack,'bridge forwards native demand without a multiplier');
   assert.ok(sample.pages[0].count>=sample.pages[0].query.countBack||sample.pages[0].boundary,
     'backend must satisfy the entire native demand or prove the upstream boundary');
   assert.ok(sample.displayed_ms<3000,`${sample.symbol}/${sample.resolution} first display ${sample.displayed_ms}ms exceeds 3s`);
  }
  fs.writeFileSync(output,JSON.stringify({passed:true,measurements,errors,
   caveat:'Display ends at public native dataReady plus two animation frames; no GPU completion claim. Each sample starts a new layout; provider API response timing and acquisition timestamp are recorded.'},null,2));
  await page.screenshot({path:output.replace(/\.json$/,'.png'),fullPage:true});
 }catch(error){const live=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  const observed=await live?.evaluate(()=>({ready,loading,pending:pending.size,symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),dataReady:widget.activeChart().dataReady()})).catch(()=>undefined);
  fs.writeFileSync(output,JSON.stringify({passed:false,error:String(error),measurements,errors,observed,requests},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
