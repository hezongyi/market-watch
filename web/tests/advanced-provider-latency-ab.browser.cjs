// Paired real first screens: same saved native layouts, routes, DB and browser.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const APP='https://localhost:15463',CHART='https://127.0.0.1:15464';
const ROOT=path.resolve('..'),DIR=path.join(ROOT,'docs/verification/provider-latency/ab-statistics');
const frames=['1','5','15','30','60','240','1D','1W','1M'];
const instruments={binance:'MWP:BTCUSDT',oanda:'MWP:OANDA:AUD_CAD'};
const now=()=>performance.now();
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const page=await context.newPage();page.setDefaultTimeout(30000);
 const control=await context.newPage();
 const requests=[],errors=[];let active=null;
 page.on('pageerror',e=>{if(active)errors.push({trial:active.id,message:e.message})});
 page.on('request',r=>{
  if(active&&r.url().endsWith('/api/charts/data')){
   const query=r.postDataJSON();const row={trial:active.id,query,at_ms:now()-active.start};
   requests.push(row);active.requests.push(row);r._abRow=row;
  }
 });
 page.on('requestfailed',r=>{if(r._abRow)r._abRow.error=r.failure()?.errorText});
 page.on('response',async r=>{
  const row=r.request()._abRow;if(!row)return;
  const body=await r.json().catch(()=>({}));
  Object.assign(row,{status:r.status(),end_ms:now()-(active?.start||0),
   count:body.bars?.length,cache_hit:body.cache_hit,boundary:body.history_boundary,
   as_of:body.as_of,timings_ms:body.timings_ms});
 });
 async function api(endpoint,body){
  return control.evaluate(async({endpoint,body})=>{
   const session=await(await fetch('/api/session')).json();
   const r=await fetch('/api/'+endpoint,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:body?JSON.stringify(body):undefined});
   if(!r.ok)throw Error(endpoint+' '+r.status);return r.json();
  },{endpoint,body});
 }
 async function create(document,name){
  const row=await api('advanced-charts/workspaces',{name});
  return api('advanced-charts/workspaces/'+row.id+'/save',{name:row.name,revision:row.revision,document});
 }
 async function frameReady(count){
  await page.frameLocator('iframe').locator('#chart').waitFor();
  const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof widget!=='undefined'&&widget!=null);
  await frame.evaluate(()=>{globalThis.abChartReady=false;widget.onChartReady(()=>{globalThis.abChartReady=true;});});
  await frame.waitForFunction(()=>abChartReady);
  await frame.waitForFunction(n=>widget.chartsCount()===n&&
   Array.from({length:n},(_,i)=>widget.chart(i)).every(c=>c.dataReady()),count);
  await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
  return frame;
 }
 const records=[],templates={};
 function persist(){fs.writeFileSync(path.join(DIR,'raw.json'),JSON.stringify({complete:false,records,errors},null,2));}
 try{
  await control.goto(APP+'/');await control.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await control.getByRole('button',{name:'登录工作台'}).click();await control.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  for(const [source,symbol] of Object.entries(instruments)){
   await create({engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'1'},'A/B layout preparation '+source);
   await page.goto(APP+'/advanced-charts');const frame=await frameReady(1);
   await frame.waitForFunction(()=>ready&&!loading);
   await frame.evaluate(()=>{widget.setLayout('2h');widget.intervalSync().setValue(false);widget.dateRangeSync().setValue(false);widget.timeSync().setValue(false);});
   await frameReady(2);
   for(let i=0;i<frames.length;i++){
    const resolutions=[frames[i],frames[(i+1)%frames.length]];
    await frame.evaluate(async values=>{
     await Promise.all(values.map((r,index)=>widget.chart(index).setResolution(r,{doNotActivateChart:true})));
    },resolutions);
    await frameReady(2);
    const state=await frame.evaluate(()=>new Promise(ok=>widget.save(ok)));
    templates[source+'|'+frames[i]]={engine:'tv31',schemaVersion:1,state,symbol,series_kind:'provider',interval:frames[i]};
   }
   await page.goto(APP+'/');
  }
  fs.writeFileSync(path.join(DIR,'native-layout-templates.json'),JSON.stringify(templates,null,2));
  // Each cycle balances source, period, scenario and which arm runs first.
  let pair=0;
  for(let cycle=0;cycle<2;cycle++)for(let f=0;f<frames.length;f++)
   for(const source of ['binance','oanda'])for(const scenario of ['single-first-screen','two-pane-first-screen']){
    const pairId=pair++;const resolution=frames[f];const panes=scenario==='single-first-screen'?1:2;
    const document=panes===1?{engine:'tv31',schemaVersion:1,symbol:instruments[source],series_kind:'provider',interval:resolution}:templates[source+'|'+resolution];
    const order=(pairId+cycle)%2?['fix','baseline']:['baseline','fix'];
    for(const arm of order){
     await page.goto('about:blank');
     await control.goto('about:blank');
     const setupStart=now();
     await execute('../.venv/bin/python',['../scripts/provider_latency_ab_fixture.py',arm],{timeout:150000,maxBuffer:1024*1024});
     await control.goto(APP+'/');
     const workspace=await create(document,`A/B ${pairId} ${arm}`);
     const record={id:records.length,pair:pairId,cycle,source,scenario,resolution,panes,arm,
      first_arm:order[0],workspace:workspace.id,started_epoch_ms:Date.now(),setup_ms:now()-setupStart,requests:[]};
     active={id:record.id,start:now(),requests:record.requests};
     try{
      await page.goto(APP+'/advanced-charts');
      const frame=await frameReady(panes);record.displayed_ms=now()-active.start;
      record.charts=await frame.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution()})));
      assert.equal(record.charts.length,panes);
      assert.ok(record.charts.every(c=>c.symbol===instruments[source]));
      assert.deepEqual(record.charts.map(c=>c.resolution),panes===1?[resolution]:[resolution,frames[(f+1)%frames.length]]);
     }catch(error){record.displayed_ms=null;record.failure=String(error);record.failed_after_ms=now()-active.start;}
     const demand=record.requests.filter(r=>r.query.firstDataRequest&&!r.query.indicators?.length);
     record.cold_requests=demand;
     record.invalid=demand.length<panes||demand.some(r=>r.status!==200||r.cache_hit!==false||!(r.count>=r.query.countBack||r.boundary));
     record.new_connection=demand.some(r=>Object.keys(r.timings_ms||{}).some(k=>k.includes('connect_tcp')||k.includes('start_tls')));
     record.new_connection_requests=demand.filter(r=>Object.keys(r.timings_ms||{}).some(k=>k.includes('connect_tcp')||k.includes('start_tls'))).length;
     record.slow=record.displayed_ms===null||record.displayed_ms>=3000;
     active=null;await page.goto('about:blank');records.push(record);persist();
     console.log(JSON.stringify({sample:records.length,pair:pairId,source,scenario,resolution,arm,ms:record.displayed_ms,slow:record.slow,new_connection:record.new_connection,invalid:record.invalid}));
    }
   }
  fs.writeFileSync(path.join(DIR,'raw.json'),JSON.stringify({complete:true,records,errors},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
