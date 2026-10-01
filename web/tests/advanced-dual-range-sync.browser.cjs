// Separate synchronized-date acceptance; independent-view soak cannot prove this.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 if(process.env.SYNC_REJECTION_TRACE==='1')await page.addInitScript(()=>{
  const origins=new WeakMap(),then=Promise.prototype.then,Native=Promise;
  globalThis.syncRejections=[];
  globalThis.Promise=class extends Native {
   constructor(executor){const origin=new Error('Promise constructor').stack;super(executor);origins.set(this,origin)}
  };
  Promise.prototype.then=function(...args){
   const next=then.apply(this,args);origins.set(next,origins.get(this)||new Error('Promise continuation').stack);return next;
  };
  addEventListener('unhandledrejection',event=>syncRejections.push({reason:String(event.reason),origin:origins.get(event.promise)}));
 });
 const errors=[],samples=[],stacks=[],dataRequests=[];let phase='initial',activeFrame,legacyDrawing;page.on('pageerror',e=>{errors.push(e.message);stacks.push({phase,stack:e.stack,message:e.message});});
 page.on('response',async response=>{
  if(!response.url().includes('/api/charts/data'))return;
  const result=await response.json().catch(()=>({}));
  dataRequests.push({phase,query:response.request().postDataJSON(),status:response.status(),count:result.bars?.length,error:result.error||result.detail,timings:result.timings_ms});
 });
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 async function frame(){await page.waitForSelector('iframe');let f;
  for(let n=0;n<600;n++){f=page.frames().find(f=>f.url().startsWith(CHART+'/'));if(f)break;await page.waitForTimeout(100);}
  assert.ok(f,'chart iframe must navigate to its origin');
  activeFrame=f;await f.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});return f;}
 async function settled(f){await f.waitForFunction(()=>!loading&&!rangeGuard.busy()&&!edgeGuard.busy()&&
  Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:60000});}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const workspace=await api('advanced-charts/workspaces',{name:'双系列日期同步验收'});
  await page.goto(APP+'/advanced-charts');let f=await frame();
  const symbols=['MWP:EURUSD','OANDA:EUR_GBP',process.env.SYNC_SECOND_PROVIDER||'MWP:BTCUSDT','OANDA:EUR_CHF'];
  await f.evaluate(()=>{widget.dateRangeSync().setValue(false);widget.setLayout('4');});
  await f.waitForFunction(()=>widget.chartsCount()===4);
  await f.evaluate(symbols=>Promise.all(symbols.map(async(symbol,i)=>{
   const c=widget.chart(i);await c.setSymbol(symbol,{doNotActivateChart:true});await c.setResolution('5',{doNotActivateChart:true});
  })),symbols);await settled(f);
  const target={to:Math.floor(Date.now()/300000)*300-600-Number(process.env.SYNC_HISTORY_SECONDS||0)};target.from=target.to-3*3600;
  phase='date-sync';await f.evaluate(target=>{widget.dateRangeSync().setValue(true);return widget.chart(0).setVisibleRange(target);},target);
  await f.waitForFunction(target=>Array.from({length:4},(_,i)=>widget.chart(i).getVisibleRange()).every(r=>
   Math.abs(r.from-target.from)<=300&&Math.abs(r.to-target.to)<=300),target,{timeout:60000});await settled(f);
  const synced=await f.evaluate(()=>Array.from({length:4},(_,i)=>({symbol:widget.chart(i).symbol(),
   resolution:widget.chart(i).resolution(),range:widget.chart(i).getVisibleRange(),spacing:widget.chart(i).getTimeScale().barSpacing()})));
  synced.forEach((c,i)=>assert.equal(c.symbol,symbols[i]));samples.push({phase:'date-sync',charts:synced});
  // Rapid period changes while date synchronization is active must settle on
  // the final choice and release obsolete requests/loading guards.
  if(!process.env.SYNC_SKIP_RAPID){
   phase='rapid';await f.evaluate(async()=>{const c=widget.chart(0);for(const r of ['1','15','60','5'])await c.setResolution(r,{doNotActivateChart:true});});
  }
  await settled(f);assert.equal(await f.evaluate(()=>widget.chart(0).resolution()),'5');
  samples.push({phase:'rapid-final',range:await f.evaluate(()=>widget.chart(0).getVisibleRange())});
  await f.waitForFunction(()=>!nativeSaving&&!rangeGuard.busy()&&!edgeGuard.busy());
  await f.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
  if(process.env.SYNC_LEGACY_SNAPSHOT==='1'){
   // Reproduce the pre-snapshot format using the supplier's public save API.
   // Keep the vendor layout opaque and include only our original viewport data.
   legacyDrawing=await f.evaluate(target=>widget.chart(0).createShape(
    {time:target.to,price:1},{shape:'horizontal_line'}),target);
   const legacy=await f.evaluate(async()=>{
    const state=await new Promise(ok=>widget.save(ok));
    return {...state,_mwViewports:captureChartViewports(widget)};
   });
   assert.equal(legacy._mwSync,undefined);
   // Close the live writer before installing an old-format fixture. A native
   // autosave must not race the fixture revision or normalize it before reopen.
   await page.goto(APP+'/');
   const saved=(await api('advanced-charts/workspaces')).find(row=>row.id===workspace.id);
   await api('advanced-charts/workspaces/'+workspace.id+'/save',{
    name:saved.name,revision:saved.revision,document:{...saved.document,state:legacy},
   });
  }
  if(process.env.SYNC_IDLE_CHECK==='1'){
   const saved=(await api('advanced-charts/workspaces')).find(row=>row.id===workspace.id);
   await page.waitForTimeout(10000);
   const later=(await api('advanced-charts/workspaces')).find(row=>row.id===workspace.id);
   assert.ok(later.revision-saved.revision<=2,'snapshot toggle restoration must not cause a perpetual autosave loop');
  }
  if(process.env.SYNC_LEGACY_SNAPSHOT==='1'){
   const saved=(await api('advanced-charts/workspaces')).find(row=>row.id===workspace.id);
   assert.equal(saved.document.state._mwSync,undefined,'first reopen must still exercise the actual legacy format');
  }
  phase='reopen';await page.goto(APP+'/advanced-charts');f=await frame();await settled(f);
  const restored=await f.evaluate(()=>({sync:widget.dateRangeSync().value(),charts:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),range:widget.chart(i).getVisibleRange()}))}));
  assert.equal(restored.sync,true);assert.equal(restored.charts.length,4);
  restored.charts.forEach((c,i)=>{assert.equal(c.symbol,symbols[i]);assert.equal(c.resolution,'5');assert.ok(c.range.to>c.range.from);});
  const finalRange=samples.at(-1).range;
  restored.charts.forEach(c=>{assert.ok(Math.abs(c.range.from-finalRange.from)<=300);assert.ok(Math.abs(c.range.to-finalRange.to)<=300);});
  if(legacyDrawing)assert.ok((await f.evaluate(()=>widget.chart(0).getAllShapes())).some(shape=>shape.id===legacyDrawing),
   'legacy synchronization recovery must retain the original native drawing');
  assert.deepEqual(errors,[]);
  fs.writeFileSync('/tmp/mw-dual-range-sync.json',JSON.stringify({passed:true,workspace:workspace.id,target,samples,restored,errors,
   legacy_format:process.env.SYNC_LEGACY_SNAPSHOT==='1',legacy_drawing:legacyDrawing},null,2));
  await page.screenshot({path:'/tmp/mw-dual-range-sync.png',fullPage:true});console.log('PASSED');
 }catch(error){const rejectionTrace=process.env.SYNC_REJECTION_TRACE==='1'?await Promise.all(page.frames().map(async f=>({url:f.url(),rejections:await f.evaluate(()=>syncRejections).catch(()=>[])}))):undefined;
  const observed=await activeFrame?.evaluate(()=>({loading,rangeBusy:rangeGuard?.busy(),edgeBusy:edgeGuard?.busy(),pending:pending.size,
  savedViewports:savedDoc.state?._mwViewports,
  charts:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),ready:widget.chart(i).dataReady(),range:widget.chart(i).getVisibleRange()}))})).catch(()=>undefined);
  fs.writeFileSync('/tmp/mw-dual-range-sync-failure.json',JSON.stringify({error:String(error),samples,errors,stacks,observed,rejectionTrace,dataRequests},null,2));await page.screenshot({path:'/tmp/mw-dual-range-sync-failure.png',fullPage:true}).catch(()=>{});throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
