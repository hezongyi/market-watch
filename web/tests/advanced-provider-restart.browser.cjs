// Keep the native document open across a real local API process restart.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
const output=process.env.PROVIDER_RESTART_OUTPUT||'/tmp/mw-provider-restart.json';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const errors=[],registrations=[];let phase='initial',frame;
 await page.addInitScript(()=>{
  const Native=globalThis.EventSource;globalThis.acceptanceStreams=[];
  globalThis.EventSource=class extends Native{
   constructor(...args){super(...args);const entry={url:args[0],events:[]};acceptanceStreams.push(entry);
    for(const type of ['open','error'])this.addEventListener(type,()=>entry.events.push({type,at:Date.now(),state:this.readyState}));}
  };
 });
 page.on('pageerror',e=>errors.push({phase,error:e.message}));
 page.on('response',r=>{if(r.url().includes('/provider/subscribe'))registrations.push({phase,status:r.status(),body:r.request().postDataJSON()})});
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 const evidence={passed:false,registrations,errors};
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const workspace=await api('advanced-charts/workspaces',{name:'平台缓存重启恢复验收'});
  await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
   document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',series_kind:'provider',interval:'5'}});
  await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
  frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});
  await frame.evaluate(()=>{
   globalThis.restartEvents=[];
   addEventListener('message',e=>{if(e.data?.type==='provider-event')restartEvents.push(e.data.event)});
  });
  await frame.waitForFunction(()=>restartEvents.some(e=>e.type==='bars'),null,{timeout:35000});
  const query={instrument:'BTCUSDT',series_kind:'provider',timeframe:'M5',countBack:200,before:Math.floor(Date.now()/300000)*300000-12*3600000};
  const before=await api('charts/data',query);
  assert.equal(before.bars.length,200);
  evidence.before={count:before.bars.length,first:before.bars[0].start,last:before.bars.at(-1).start,as_of:before.as_of};
  evidence.view_before=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()}));
  phase='restart';const began=Date.now();
  execFileSync('sg',['docker','-c','docker restart market-watch-dual-acceptance-api-1'],{timeout:60000,stdio:'pipe'});
  for(let n=0;n<60;n++){
   const ok=await page.evaluate(()=>fetch('/api/health').then(r=>r.ok).catch(()=>false));
   if(ok)break;
   if(n===59)throw Error('API did not recover');await page.waitForTimeout(1000);
  }
  evidence.restart_ms=Date.now()-began;
  const requested=Date.now(),after=await api('charts/data',query);
  evidence.persisted_request_ms=Date.now()-requested;
  assert.equal(after.cache_hit,true,'a real process restart must retain proven historical slices');
  assert.deepEqual(after.bars,before.bars,'persisted OHLC and ordering survive restart exactly');
  const expiry=Date.now()+45000;
  while(!registrations.some(r=>r.phase==='restart'&&r.status===200)&&Date.now()<expiry)await page.waitForTimeout(500);
  assert.ok(registrations.some(r=>r.phase==='restart'&&r.status===200),'EventSource reconnect re-registers current native listeners');
  await frame.waitForFunction(began=>restartEvents.some(e=>e.type==='bars'&&e.as_of>=began),began,{timeout:45000});
  evidence.resumed_ms=Date.now()-began;
  evidence.events=await frame.evaluate(()=>restartEvents.map(e=>({type:e.type,cursor:e.cursor,revision:e.revision,as_of:e.as_of,count:e.bars?.length})));
  assert.ok(!evidence.events.some(e=>e.type==='reset'),'ordinary short restart with covered cursor resumes without resetting history');
  await frame.waitForFunction(()=>pending.size===0,null,{timeout:10000});
  evidence.view_after=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing(),ready:widget.activeChart().dataReady(),pending:pending.size}));
  assert.equal(evidence.view_after.ready,true);assert.equal(evidence.view_after.pending,0);
  assert.equal(evidence.view_after.spacing,evidence.view_before.spacing);
  assert.deepEqual(errors,[]);evidence.passed=true;
 }catch(error){evidence.error=String(error);throw error}
 finally{evidence.streams=await page.evaluate(()=>acceptanceStreams).catch(()=>[]);fs.writeFileSync(output,JSON.stringify(evidence,null,2));await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
