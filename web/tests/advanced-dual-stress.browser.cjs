// Real native library + real provider requests. Browser drivers run serially.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
const OUTPUT='/tmp/mw-dual-stress.json';
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const errors=[],requests=[],responses=[],cold=[],switches=[],soak=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('/api/charts/data'))requests.push(r.postDataJSON());});
 page.on('response',async r=>{if(r.url().includes('/api/charts/data'))responses.push({status:r.status(),query:r.request().postDataJSON(),body:await r.json().catch(()=>({}))});});
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 async function getFrame(){
  await page.frameLocator('iframe').locator('#chart').waitFor();const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  assert.ok(frame);await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});return frame;
 }
 function persist(extra={}){fs.writeFileSync(OUTPUT,JSON.stringify({passed:false,cold,switches,soak,errors,...extra},null,2));}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const originalPlans=await api('market-data/history/plans');
  const candidates=['GBP_CAD','AUD_NZD','GBP_CHF','USD_SGD','CAD_CHF','NZD_CAD',
   'NZD_CHF','AUD_SGD','EUR_NZD','GBP_NZD','USD_HKD','USD_DKK'];
  const symbols=[];
  for(const symbol of candidates){
   if(originalPlans.some(row=>row.instrument==='OANDA:'+symbol))continue;
   const catalog=await api('market-data/catalog?query='+symbol);
   if(catalog.some(row=>row.id==='OANDA:'+symbol&&row.supported&&row.available))symbols.push(symbol);
   if(symbols.length===6)break;
  }
  assert.equal(symbols.length,6,'six genuinely unmaintained supported provider fixtures are required');
  // Each cold sample starts a new native document on a previously unused
  // instrument. No request routing, mock data, or measured in-memory adapter.
  for(const symbol of symbols){
   const catalog=await api('market-data/catalog?query='+symbol);
   assert.ok(catalog.some(row=>row.id==='OANDA:'+symbol&&row.supported&&row.available));
   assert.ok(!originalPlans.some(row=>row.instrument==='OANDA:'+symbol));
   const workspace=await api('advanced-charts/workspaces',{name:'平台冷首屏 '+symbol});
   await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
    document:{engine:'tv31',schemaVersion:1,symbol:'MWP:OANDA:'+symbol,series_kind:'provider',interval:'5'}});
   const began=Date.now();await page.goto(APP+'/advanced-charts');const frame=await getFrame();
   const state=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),range:widget.activeChart().getVisibleRange()}));
   assert.equal(state.symbol,'MWP:OANDA:'+symbol);assert.ok(state.range.to>state.range.from);
   const firstPage=responses.filter(r=>r.query.instrument==='OANDA:'+symbol).at(-1);
   assert.ok(firstPage?.body.as_of>=began,'cold native document must receive a newly acquired provider page');
   cold.push({elapsed_ms:Date.now()-began,provider_as_of:firstPage.body.as_of,...state});persist();console.log('COLD',JSON.stringify(cold.at(-1)));
  }
  let frame=await getFrame();
  // Every resolution's initial native load is measured separately from the
  // repeated native cache switches, ending at dataReady + two paint opportunities.
  for(let round=0;round<4;round++)for(const resolution of ['1','5','15','30','60','240','1D','1W','1M']){
   const sample=await frame.evaluate(async resolution=>{
    const chart=widget.activeChart(),start=performance.now();
    await chart.setResolution(resolution,{doNotActivateChart:true});
    await new Promise(ok=>chart.dataReady(ok));
    await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
    return {elapsed_ms:performance.now()-start,resolution:chart.resolution(),range:chart.getVisibleRange()};
   },resolution);
   assert.equal(sample.resolution,resolution);assert.ok(sample.range.to>sample.range.from);
   switches.push({round,...sample});persist();
  }
  const studies=await frame.evaluate(()=>widget.getStudiesList());
  for(const name of ['Moving Average','Moving Average Exponential','Moving Average Weighted','Bollinger Bands','Relative Strength Index','MACD','Average True Range','Stochastic']){
   assert.ok(studies.includes(name));const id=await frame.evaluate(name=>widget.activeChart().createStudy(name,false,false),name);
   assert.ok(id);await frame.evaluate(id=>widget.activeChart().removeEntity(id),id);
  }
  // Actual native UI labels are recorded for subsequent rapid-click acceptance.
  const native=page.frames().find(f=>f.parentFrame()===frame);
  assert.ok(native,'native UI must be rendered in its own frame');
  const buttons=await native.locator('[role="button"],button').evaluateAll(rows=>rows.map(row=>({label:row.getAttribute('aria-label'),text:row.textContent?.trim(),name:row.getAttribute('data-name')})));
  console.log('NATIVE_BUTTONS',JSON.stringify(buttons.filter(row=>row.label||row.text).slice(0,60)));
  await frame.evaluate(async()=>{
   const c=widget.activeChart();await c.setSymbol('MWP:BTCUSDT',{doNotActivateChart:true});await c.setResolution('60',{doNotActivateChart:true});
   globalThis.compareId=await c.createStudy('Compare',true,false,{symbol:'MWP:XAUUSD'},undefined,{priceScale:'new-left'});
  });
  await frame.waitForFunction(()=>{
   const pane=widget.activeChart().getPanes()[0],left=pane.getLeftPriceScales()[0]?.getVisiblePriceRange(),right=pane.getMainSourcePriceScale().getVisiblePriceRange();
   return left?.from>1000&&left?.to<10000&&right?.from>10000;
  },null,{timeout:60000});
  const comparison=await frame.evaluate(()=>({tracked:hasHistoryViewer({instrument:'MWP:XAUUSD',timeframe:'H1'}),inputs:widget.activeChart().getStudyById(compareId).getInputValues()}));
  assert.ok(comparison.tracked);assert.ok(comparison.inputs.some(i=>i.id==='symbol'&&i.value==='MWP:XAUUSD'));
  await frame.evaluate(()=>widget.activeChart().removeEntity(compareId));
  // Resource soak uses independent viewports. A separate range-sync test owns
  // matching dates across differing calendars; native date sync can legitimately
  // refit fractional spacing to match the same dates on unequal datasets.
  await frame.evaluate(()=>{widget.dateRangeSync().setValue(false);widget.setLayout('8');});
  await frame.waitForFunction(()=>widget.chartsCount()===8);
  const paneSymbols=['MWP:EURUSD','OANDA:EUR_GBP','MWP:BTCUSDT','OANDA:EUR_CHF'];
  await frame.evaluate(symbols=>Promise.all(Array.from({length:8},async(_,i)=>{
   const chart=widget.chart(i);await chart.setSymbol(symbols[i%4],{doNotActivateChart:true});await chart.setResolution('5',{doNotActivateChart:true});
  })),paneSymbols);
  await frame.waitForFunction(()=>Array.from({length:8},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:60000});
  // Choose the user spacing explicitly after the native layout's initial fit.
  await frame.evaluate(()=>Array.from({length:8},(_,i)=>widget.chart(i).getTimeScale().setBarSpacing(6)));
  const before=await api('market-data/history/plans');const history=before.find(p=>p.instrument==='OANDA:EUR_GBP');
  await api('market-data/history/plans/control',{instrument:history.instrument,action:'resume'});
  const duration=Number(process.env.DUAL_SOAK_SECONDS||300)*1000,soakStart=Date.now();
  try{
   while(Date.now()-soakStart<duration){
    const observed=await frame.evaluate(()=>({pending:pending.size,subscriptions:subscriptions.size,
     charts:Array.from({length:8},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),range:widget.chart(i).getVisibleRange(),spacing:widget.chart(i).getTimeScale().barSpacing()}))}));
    observed.charts.forEach((chart,i)=>{assert.equal(chart.symbol,paneSymbols[i%4]);assert.equal(chart.resolution,'5');assert.ok(chart.range.to>chart.range.from);assert.equal(chart.spacing,6);});
    const plans=await api('market-data/history/plans');
    const maintained=plans.filter(p=>['BTCUSDT','OANDA:EUR_GBP','OANDA:EUR_CHF'].includes(p.instrument));
    const sample={elapsed_ms:Date.now()-soakStart,...observed,managed:maintained.map(p=>({instrument:p.instrument,realtime_end:p.realtime_end,latency_ms:Date.now()-p.realtime_end,cursor:p.cursor,status:p.status}))};
    soak.push(sample);persist({comparison});console.log('SOAK',JSON.stringify({elapsed_ms:sample.elapsed_ms,managed:sample.managed}));
    assert.ok(sample.managed.every(p=>p.latency_ms<120000),'maintained publication must stay within 120s during concurrent provider/history load');
    await page.waitForTimeout(10000);
   }
  }finally{if(history.status==='cancelled')await api('market-data/history/plans/control',{instrument:history.instrument,action:'cancel'});}
  const after=await api('market-data/history/plans');
  for(const symbol of symbols)assert.ok(!after.some(p=>p.instrument==='OANDA:'+symbol),'provider cold loads must not maintain M1');
  assert.ok(responses.length&&responses.every(r=>r.status===200));assert.deepEqual(errors,[]);
  const hot=switches.filter(s=>s.round>0).map(s=>s.elapsed_ms),coldValues=cold.map(s=>s.elapsed_ms);
  const evidence={passed:true,cold,switches,soak,comparison,native_indicators:8,errors,
   latency:{cold_native_document:{n:coldValues.length,p50_ms:percentile(coldValues,.5),p95_ms:percentile(coldValues,.95)},
    warm_native_switch:{n:hot.length,p50_ms:percentile(hot,.5),p95_ms:percentile(hot,.95)}},
   range_sync:false,
   caveat:'Cold document timing includes web/native initialization; repeated switch includes native/API cache behavior. This is not GPU render completion.'};
  fs.writeFileSync(OUTPUT,JSON.stringify(evidence,null,2));await page.screenshot({path:'/tmp/mw-dual-stress.png',fullPage:true});
  console.log('PASSED',JSON.stringify(evidence.latency));
 }catch(error){persist({error:String(error)});await page.screenshot({path:'/tmp/mw-dual-stress-failure.png',fullPage:true}).catch(()=>{});throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
