// Real PostgreSQL cache, providers and native callbacks through both HTTPS proxies.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
const output=process.env.PROVIDER_SERVICE_OUTPUT||'/tmp/mw-provider-cache-service.json';
const symbol=process.env.PROVIDER_SERVICE_SYMBOL||'MWP:OANDA:AUD_CAD';
const upstreamSymbol=symbol.includes('OANDA:')?symbol.split(':').at(-1):symbol.slice(4);
const instrument=symbol.slice(4);
const fixture=(...args)=>JSON.parse(execFileSync('../.venv/bin/python',['../scripts/provider_acceptance_fixture.py','--instrument',instrument,...args],
 {env:{...process.env,PYTHONPATH:'../backend'},timeout:45000}).toString());
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const errors=[],pages=[],measurements=[];let latest;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async response=>{
  if(response.url().includes('/api/charts/data')) {
   const result=await response.json().catch(()=>({}));pages.push({query:response.request().postDataJSON(),status:response.status(),count:result.bars?.length,cache_hit:result.cache_hit});
  }
 });
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const response=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw Error(path+' '+response.status);return response.json();
 },{path,body});}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const baseline=fixture('--reset');
  const workspace=await api('advanced-charts/workspaces',{name:'后端缓存与订阅验收'});
  await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
   document:{engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'5'}});
  await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
  const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});
  await frame.evaluate(()=>{
   globalThis.providerEventsObserved=[];
   addEventListener('message',e=>{if(e.data?.type==='provider-event')providerEventsObserved.push({type:e.data.event.type,at:Date.now(),count:e.data.event.bars?.length,indicators:e.data.event.indicators?.length})});
   globalThis.providerCallbacks=[];
   for(const sub of subscriptions.values())if(sub.providerListener){const original=sub.cb;sub.cb=bar=>{providerCallbacks.push({time:bar.time,at:Date.now()});original(bar)}}
  });
  await frame.waitForFunction(()=>providerCallbacks.length>0,null,{timeout:35000});
  const nativeCallbacks=await frame.evaluate(()=>({events:providerEventsObserved,callbacks:providerCallbacks}));
  assert.ok(nativeCallbacks.events.some(e=>e.type==='bars'));
  const warmStart=Date.now();
  while(Date.now()-warmStart<100000){
   latest=fixture();
   const rows=latest.datasets.filter(d=>d.symbol===upstreamSymbol);
   if(rows.length===9&&rows.every(d=>d.count>=4000||d.earliest))break;
   await page.waitForTimeout(1000);
  }
  assert.equal(latest.datasets.filter(d=>d.symbol===upstreamSymbol).length,9);
  assert.ok(latest.datasets.filter(d=>d.symbol===upstreamSymbol).every(d=>d.count>=4000||d.earliest),'all finite depth targets must complete or reach real boundary');
  const warmCompleted=Date.now()-warmStart;
  for(const resolution of ['1D','240','5']){
   const started=Date.now();
   await frame.evaluate(r=>widget.activeChart().setResolution(r,{doNotActivateChart:true}),resolution);
   await frame.waitForFunction(()=>widget.activeChart().dataReady());
   measurements.push({resolution,elapsed_ms:Date.now()-started});
  }
  const cacheResponse=await api('charts/data',{instrument,series_kind:'provider',timeframe:'M5',limit:200,client:'acceptance-fresh'});
  assert.equal(cacheResponse.cache_hit,true);assert.equal(cacheResponse.bars.length,200);
  await frame.evaluate(()=>widget.activeChart().createStudy('守望 Python SMA',false,false,{period:20}));
  await frame.waitForFunction(()=>[...subscriptions.values()].some(s=>decode(s.symbol).spec&&s.providerListener));
  await frame.waitForFunction(()=>providerEventsObserved.some(e=>e.type==='bars'&&e.indicators>0),null,{timeout:35000});
  const allEvents=await frame.evaluate(()=>providerEventsObserved);
  const dataCount=pages.length;
  await page.waitForTimeout(16000);
  assert.equal(pages.length,dataCount,'provider and Python subscribers must not poll the data API from the front end');
  assert.ok(pages.every(p=>p.status===200));assert.deepEqual(errors,[]);
  const final=fixture();
  assert.deepEqual(final.test_symbol_managed_plans,baseline.test_symbol_managed_plans,'platform requests cannot alter approved managed starts or realtime switches');
  if(baseline.test_symbol_managed_plans.length===0){
   assert.equal(final.test_symbol_managed_bars,baseline.test_symbol_managed_bars,'platform cache must not write managed bars for an unmanaged test symbol');
   assert.equal(final.test_symbol_managed_jobs,baseline.test_symbol_managed_jobs,'platform cache must not create managed jobs for an unmanaged test symbol');
  }
  await page.goto(APP+'/');
  let released;
  for(let n=0;n<70;n++){released=fixture();if(!released.subscriptions)break;await page.waitForTimeout(1000)}
  assert.equal(released.subscriptions,0,'closing the chart releases subscriptions or expires their leases');
  const evidence={passed:true,symbol,baseline,warm_elapsed_ms:warmCompleted,measurements,nativeCallbacks,allEvents,pages,final,released,errors};
  fs.writeFileSync(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 }catch(error){fs.writeFileSync(output,JSON.stringify({passed:false,error:String(error),pages,measurements,latest,errors},null,2));throw error}
 finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
