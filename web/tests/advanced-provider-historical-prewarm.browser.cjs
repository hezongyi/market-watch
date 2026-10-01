// Real API + PostgreSQL acquisition acceptance; this is not a native render timing test.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const APP='https://localhost:15453',instrument='OANDA:AUD_CAD';
const output=process.env.HISTORY_PREWARM_OUTPUT||'../docs/verification/provider-cache/historical-prewarm-live.json';
const client='acceptance-history-'+Date.now(),peer=client+'-peer';
const fixture=(session,...args)=>JSON.parse(execFileSync('../.venv/bin/python',
 ['../scripts/provider_acceptance_fixture.py','--instrument',instrument,'--client',session,...args],
 {env:{...process.env,PYTHONPATH:'../backend'},timeout:45000}).toString());
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true});
 const errors=[],evidence={client,peer,errors};page.on('pageerror',e=>errors.push(e.message));
 async function data(body){return page.evaluate(async body=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const started=performance.now(),r=await fetch('/api/charts/data',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  const result=await r.json();if(!r.ok)throw Error('data '+r.status+' '+JSON.stringify(result));
  return {elapsed_ms:performance.now()-started,result};
 },body);}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  evidence.baseline=fixture(client,'--reset');
  const before=Date.parse('2026-08-28T20:55:00Z'); // Friday anchor: right buffer must cross real market closures.
  const demand={instrument,series_kind:'provider',timeframe:'M5',before,from:before-200*300000,countBack:200,limit:200,firstDataRequest:false,client};
  evidence.initial=await data(demand);assert.equal(evidence.initial.result.bars.length,200);
  evidence.peer=await data({...demand,client:peer});assert.equal(evidence.peer.result.cache_hit,true);
  assert.deepEqual(evidence.peer.result.bars,evidence.initial.result.bars,'sessions share durable range data');
  assert.ok(evidence.peer.elapsed_ms<1000,'complete historical DB cache request must be below 1s');
  const start=Date.now();let snapshot;
  while(Date.now()-start<240000){
   snapshot=fixture(client);const interest=snapshot.interests.find(i=>i.listener.endsWith(':history'));
   if(interest?.targets.length===20&&interest.targets.every(t=>t.done))break;
   await page.waitForTimeout(1500);
  }
  evidence.warm_ms=Date.now()-start;evidence.snapshot=snapshot;
  const own=snapshot.interests.find(i=>i.listener.endsWith(':history'));
  assert.equal(own.targets.length,20);assert.ok(own.targets.every(t=>t.done),'all finite historic goals complete');
  for(const target of own.targets){
   assert.equal(target.connected,true,'successful warming requires actual coverage');
   assert.ok(target.actual>=target.count||target.earliest===true||target.before>=target.until,'actual bars or proven boundary satisfy the goal');
   if(target.after!=null){assert.equal(target.after,before);assert.ok(target.actual>=target.count,'Friday right buffer counts bars beyond closures');}
   else assert.equal(target.before,before,'cross-period targets keep the same fixed date anchor');
  }
  evidence.peerSnapshot=fixture(peer);
  assert.ok(evidence.peerSnapshot.interests.some(i=>i.cursor===before),'peer owns its own bounded interest');
  for(const timeframe of ['D1','W1','H4','M5','M1','MN','H1','M30','M15']){
   const read=await data({...demand,timeframe,client:peer});
   assert.equal(read.result.cache_hit,true,'cross-period historic request must reuse prewarm');
   assert.ok(read.elapsed_ms<1000);(evidence.switches??=[]).push({timeframe,elapsed_ms:read.elapsed_ms,count:read.result.bars.length});
  }
  // Those explicit cross-period reads legitimately create their own bounded
  // neighbor targets. Wait for them before asserting the scheduler is idle.
  const peerStart=Date.now();let peerFinal;
  while(Date.now()-peerStart<240000){
   peerFinal=fixture(peer);if(peerFinal.interests.every(i=>i.targets.every(t=>t.done)))break;
   await page.waitForTimeout(1500);
  }
  evidence.peerFinal=peerFinal;
  assert.ok(peerFinal.interests.every(i=>i.targets.every(t=>t.done)),'new explicit read targets complete before the idle check');
  const stable=fixture(client).datasets.filter(d=>d.symbol==='AUD_CAD');await page.waitForTimeout(15000);
  const later=fixture(client).datasets.filter(d=>d.symbol==='AUD_CAD');
  assert.deepEqual(later.map(d=>[d.frame,d.count,d.revision,d.coverage]),stable.map(d=>[d.frame,d.count,d.revision,d.coverage]),'completed historic goals cannot recursively extend or refetch');
  assert.deepEqual(errors,[]);evidence.passed=true;
 }catch(error){evidence.passed=false;evidence.error=String(error);throw error;}
 finally{
  for(const session of [client,peer])fixture(session,'--expire-client');
  fs.writeFileSync(output,JSON.stringify(evidence,null,2));await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1});
