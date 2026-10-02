// Public resetData path on a real historical cache revision; no vendor edits.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const APP='https://localhost:15473',CHART='https://127.0.0.1:15474';
const output=process.env.PROVIDER_REVISION_OUTPUT||'../docs/verification/native-history/implementation/browser-revision.json';
const marker='/tmp/mw-provider-revision-'+process.pid+'.json';
const inject=(action,offset=20)=>JSON.parse(execFileSync('/home/quant/repos/market-watch/.venv/bin/python',['../scripts/provider_revision_fixture.py',action,'--marker',marker,'--native-history','--offset',String(offset)],
 {env:{...process.env,PYTHONPATH:'../backend'},timeout:45000}).toString());
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const errors=[],pages=[];let frame;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes('/api/charts/data'))pages.push({at:Date.now(),status:r.status(),query:r.request().postDataJSON()})});
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 const evidence={passed:false,errors,pages};
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const workspace=await api('advanced-charts/workspaces',{name:'平台历史修订保视区验收'});
  await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
   document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',series_kind:'provider',interval:'5'}});
  await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
  frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});
  await frame.evaluate(()=>{
   globalThis.revisionEvents=[];
   addEventListener('message',e=>{if(e.data?.type==='provider-event')revisionEvents.push(e.data.event)});
   globalThis.resetCalls=0;
   globalThis.deliveredRevisionBars=[];
   const getBars=feed.getBars;
   feed.getBars=(s,res,p,cb,err)=>getBars(s,res,p,(bars,meta)=>{deliveredRevisionBars.push(...bars);cb(bars,meta)},err);
   for(const sub of subscriptions.values())if(sub.providerListener){const original=sub.reset;sub.reset=()=>{resetCalls++;return original()}}
  });
  await frame.waitForFunction(()=>revisionEvents.some(e=>e.type==='bars'),null,{timeout:35000});
  const dataset=inject('snapshot');
  assert.ok(dataset);
  const beforeResets=await frame.evaluate(()=>resetCalls);
  await api('charts/data',{instrument:'BTCUSDT',series_kind:'provider',timeframe:'M5',before:dataset.coverage[0][0],countBack:10});
  await page.waitForTimeout(2500);
  assert.equal(await frame.evaluate(()=>resetCalls),beforeResets,'adding previously uncached history does not invalidate the displayed chart');
  evidence.extra_history_no_reset=true;
  const target={to:Math.floor(Date.now()/300000)*300-3600};target.from=target.to-6*3600;
  await frame.evaluate(target=>widget.activeChart().setVisibleRange(target),target);
  await frame.waitForFunction(()=>widget.activeChart().dataReady()&&!rangeGuard.busy()&&!edgeGuard.busy());
  evidence.view_before=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()}));
  // Hold an existing public-reload guard while the backend revision arrives.
  await frame.evaluate(()=>{loading=true});
  const began=Date.now();evidence.injection=inject('revise');
  await frame.waitForFunction(()=>revisionEvents.some(e=>e.type==='reset'),null,{timeout:10000});
  assert.ok(await frame.evaluate(()=>[...subscriptions.values()].some(s=>s.needsHistoryReload)),'busy reset remains pending');
  await frame.evaluate(()=>{loading=false});
  await frame.waitForFunction(()=>resetCalls>0&&!historyReloading&&widget.activeChart().dataReady()&&![...subscriptions.values()].some(s=>s.needsHistoryReload),null,{timeout:40000});
  evidence.reload_ms=Date.now()-began;
  evidence.view_after=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing(),ready:widget.activeChart().dataReady()}));
  assert.equal(evidence.view_after.spacing,evidence.view_before.spacing);
  for(const edge of ['from','to'])assert.ok(Math.abs(evidence.view_after.range[edge]-evidence.view_before.range[edge])<=300,'historical reload preserves viewport');
  const expires=Date.now()+20000;
  while(!pages.some(p=>p.at>=began&&p.status===200)&&Date.now()<expires)await page.waitForTimeout(250);
  assert.ok(pages.some(p=>p.at>=began&&p.status===200),'public reset refetches the revised history');
  const cached=await api('charts/data',{instrument:'BTCUSDT',series_kind:'provider',timeframe:'M5',before:evidence.injection.start+300000,countBack:1});
  const actual=await frame.evaluate(start=>deliveredRevisionBars.filter(bar=>bar.time===start),evidence.injection.start);
  evidence.revised_native_callbacks=actual;
  assert.ok(actual.length,'public getBars callback delivers the revised bucket to native');
  assert.equal(actual.at(-1).close,Number(evidence.injection.close),'native callback receives the exact injected revised close');
  assert.equal(actual.at(-1).close,Number(cached.bars[0].close),'native callback receives the revised cache close');
  evidence.export_limitation='Native exportData cannot be used here: supplied vendor package lacks zh.20866 chunk. Verification observes public getBars callback and dataReady instead.';
  evidence.events=await frame.evaluate(()=>revisionEvents.map(e=>({type:e.type,cursor:e.cursor,revision:e.revision,as_of:e.as_of})));
  // Delayed revision/backfill interleaves use the dedicated fresh-workspace
  // advanced-native-history-late.browser.cjs and acceptance barrier entrypoint.
  assert.ok(pages.every(p=>p.status===200),'all history responses must succeed');
  await page.screenshot({path:output.replace('.json','.png')});
  assert.deepEqual(errors,[]);evidence.passed=true;
 }catch(error){evidence.error=String(error);evidence.events=await frame?.evaluate(()=>revisionEvents.map(e=>({type:e.type,revision:e.revision,cursor:e.cursor}))).catch(()=>[]);throw error}
 finally{
  if(fs.existsSync(marker))evidence.restoration=inject('restore');
  fs.writeFileSync(output,JSON.stringify(evidence,null,2));await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1});
