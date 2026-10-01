// Real native UI rapid interval clicks, cold-load timing trace and saved comparison.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const errors=[],network=[],starts=new Map();let began;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{
  if(/\/api\/(?:charts\/data|market-data\/(?:quotes|resolve|catalog)|advanced-charts\/)/.test(r.url()))
   starts.set(r,Date.now());
 });
 page.on('response',async r=>{
  const start=starts.get(r.request());if(start==null||!began)return;
  const payload=r.request().postDataJSON();
  network.push({path:new URL(r.url()).pathname,at_ms:start-began,elapsed_ms:Date.now()-start,status:r.status(),
   query:payload?.instrument?{instrument:payload.instrument,timeframe:payload.timeframe,limit:payload.limit,before:payload.before}:undefined});
 });
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const workspace=await api('advanced-charts/workspaces',{name:'原生快速操作和网络分解'});
  await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
   document:{engine:'tv31',schemaVersion:1,symbol:'MWP:OANDA:EUR_AUD',series_kind:'provider',interval:'5'}});
  began=Date.now();await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
  let frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});
  const firstReady=Date.now()-began;
  const native=page.frames().find(f=>f.parentFrame()===frame);assert.ok(native);
  const buttons=await native.locator('[role="button"],button').evaluateAll(rows=>rows.map(row=>({label:row.getAttribute('aria-label'),text:row.textContent?.trim(),name:row.getAttribute('data-name'),title:row.getAttribute('title')})));
  console.log('BUTTONS',JSON.stringify(buttons.filter(row=>row.label||row.text).slice(0,80)));
  const uiSamples=[];
  // These selectors drive the native user interface only, never product logic.
  for(const resolution of ['1','5','60','1D','5']){
   const started=Date.now();
   await native.getByRole('button',{name:/^\d+\s*(?:分钟|小时|天|日|周|月)$/}).first().click();
   const button=native.locator(`[data-value="${resolution}"]`).first();
   if(await button.count())await button.click();
   else{
    const name={'1':/^1\s*(?:分钟|分)$/,'5':/^5\s*(?:分钟|分)$/,'60':/^1\s*小时$/,'1D':/^1\s*(?:天|日)$/}[resolution];
    await native.getByText(name,{exact:true}).first().click();
   }
   await frame.waitForFunction(res=>widget.activeChart().resolution()===res,resolution,{timeout:10000});
   uiSamples.push({resolution,click_ms:Date.now()-started});
  }
  await frame.waitForFunction(()=>widget.activeChart().resolution()==='5'&&widget.activeChart().dataReady()&&!rangeGuard.busy(),null,{timeout:60000});
  await frame.evaluate(async()=>{
   const c=widget.activeChart();await c.setSymbol('MWP:BTCUSDT',{doNotActivateChart:true});await c.setResolution('60',{doNotActivateChart:true});
   globalThis.compareId=await c.createStudy('Compare',true,false,{symbol:'MWP:XAUUSD'},undefined,{priceScale:'new-left'});
  });
  await frame.waitForFunction(()=>widget.activeChart().dataReady()&&widget.activeChart().getPanes()[0].getLeftPriceScales()[0]?.getVisiblePriceRange()?.from>1000,null,{timeout:60000});
  await frame.evaluate(()=>{
   const pane=widget.activeChart().getPanes()[0];pane.getLeftPriceScales()[0].setMode(2);pane.getMainSourcePriceScale().setMode(2);
  });
  await frame.waitForFunction(()=>!loading&&!nativeSaving&&!rangeGuard.busy()&&!edgeGuard.busy());
  await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
  await page.reload();await page.frameLocator('iframe').locator('#chart').waitFor();frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady()&&widget.activeChart().getPanes()[0].getLeftPriceScales().length===1,null,{timeout:60000});
  const restored=await frame.evaluate(()=>{
   const c=widget.activeChart(),pane=c.getPanes()[0];return {symbol:c.symbol(),resolution:c.resolution(),
    modes:[pane.getLeftPriceScales()[0].getMode(),pane.getMainSourcePriceScale().getMode()],
    studies:c.getAllStudies().map(s=>c.getStudyById(s.id).getInputValues()),
    tracked:hasHistoryViewer({instrument:'MWP:XAUUSD',timeframe:'H1'})};
  });
  assert.equal(restored.symbol,'MWP:BTCUSDT');assert.equal(restored.resolution,'60');assert.deepEqual(restored.modes,[2,2]);
  assert.ok(restored.tracked&&restored.studies.some(inputs=>inputs.some(i=>i.id==='symbol'&&i.value==='MWP:XAUUSD')));
  assert.deepEqual(errors,[]);
  const evidence={passed:true,first_ready_ms:firstReady,network,uiSamples,restored,errors};
  fs.writeFileSync('/tmp/mw-dual-native-ui.json',JSON.stringify(evidence,null,2));
  await page.screenshot({path:'/tmp/mw-dual-native-ui.png',fullPage:true});console.log('PASSED',JSON.stringify({firstReady,uiSamples,restored}));
 }catch(error){fs.writeFileSync('/tmp/mw-dual-native-ui-failure.json',JSON.stringify({error:String(error),network,errors},null,2));await page.screenshot({path:'/tmp/mw-dual-native-ui-failure.png',fullPage:true}).catch(()=>{});throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
