const {chromium}=require('@playwright/test'),fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const APP=process.env.VOLUME_APP||'https://localhost:15553',CHART=process.env.VOLUME_CHART||'https://127.0.0.1:15554';
 const OUT=process.env.VOLUME_OUTPUT||path.resolve(__dirname,'../../docs/verification/volume/native-load.json');
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'}),p=await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const evidence={passed:false,cold:[],warm:[],soak:[],errors:[]};
 const requests=[],startedRequests=new Map(),pending=[];
 p.on('request',r=>{if(r.url().endsWith('/api/charts/data'))startedRequests.set(r,Date.now())});
 p.on('response',r=>{if(startedRequests.has(r.request()))pending.push((async()=>{
  const data=await r.json();requests.push({query:r.request().postDataJSON(),started:startedRequests.get(r.request()),cache_hit:data.cache_hit,count:data.bars?.length,boundary:data.history_boundary});
 })())});
 p.on('pageerror',e=>evidence.errors.push(e.message));
 async function api(path,body){return p.evaluate(async({path,body})=>{const {csrf}=await(await fetch('/api/session')).json();const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(path+' '+r.status);return r.json()},{path,body});}
 const save=()=>fs.writeFileSync(OUT,JSON.stringify(evidence,null,2));
 try{
  await p.goto(APP+'/');await p.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../market-watch/artifacts/local-credentials.json'))).password);await p.getByRole('button',{name:'登录工作台'}).click();await p.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const ws=await api('advanced-charts/workspaces',{name:'Volume load acceptance'});await api('advanced-charts/workspaces/'+ws.id+'/save',{name:ws.name,revision:ws.revision,document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',interval:'5'}});
  await p.goto(APP+'/advanced-charts');await p.frameLocator('iframe').locator('#chart').waitFor({timeout:60000});let f=p.frames().find(f=>f.url().startsWith(CHART+'/'));await f.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});
  for(const symbol of ['USD_CNH','EUR_DKK','USD_DKK','USD_MXN','USD_ZAR','USD_TRY']){
   const offset=requests.length;
   const sample=await f.evaluate(async symbol=>{const c=widget.activeChart(),start=performance.now();await new Promise(ok=>c.setSymbol('MWP:OANDA:'+symbol,ok));await new Promise(ok=>c.dataReady(ok));await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));return {symbol,ms:performance.now()-start}},symbol);
   await Promise.all(pending);sample.requests=requests.slice(offset);evidence.cold.push(sample);save();console.log('cold',sample);
  }
  for(const resolution of ['1','5','15','30','60','240','1D','1W','1M']){
   await f.evaluate(async resolution=>{const c=widget.activeChart();await new Promise(ok=>c.setResolution(resolution,ok));await new Promise(ok=>c.dataReady(ok))},resolution);
   await f.waitForFunction(()=>!loading&&!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy());
   await f.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
   await Promise.all(pending);
   const demand=requests.at(-1).query;
   await api('charts/data',{...demand,before:undefined,countBack:(demand.countBack||demand.limit)+32,limit:(demand.countBack||demand.limit)+32});
   await Promise.all(pending);
   const offset=requests.length;
   await p.reload();await p.frameLocator('iframe').locator('#chart').waitFor({timeout:60000});
   f=p.frames().find(f=>f.url().startsWith(CHART+'/'));
   await f.waitForFunction(()=>typeof widget!=='undefined'&&widget,null,{timeout:60000});
   await f.evaluate(()=>new Promise(ok=>widget.onChartReady(ok)));
   await f.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
   await f.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
   await Promise.all(pending);
   const pages=requests.slice(offset),sample={resolution,ms:Date.now()-pages[0].started,requests:pages};
   evidence.warm.push(sample);save();console.log('warm',sample);
   assert.ok(pages.length&&pages.every(r=>r.cache_hit===true),'Warm measurement must read proven backend cache');
  }
  await f.evaluate(()=>{widget.dateRangeSync().setValue(false);widget.setLayout('8')});await f.waitForFunction(()=>widget.chartsCount()===8);
  const symbols=['MWP:BTCUSDT','BTCUSDT','MWP:OANDA:CAD_CHF','OANDA:CAD_CHF'];
  await f.evaluate(symbols=>Promise.all(Array.from({length:8},async(_,i)=>{const c=widget.chart(i);await c.setSymbol(symbols[i%4],{doNotActivateChart:true});await c.setResolution('5',{doNotActivateChart:true});await c.createStudy('Volume',false,false)})),symbols);
  await f.waitForFunction(()=>Array.from({length:8},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:60000});
  await api('market-data/history/volume/start',{instrument:'EURUSD'});
  await api('market-data/history/volume/start',{instrument:'XAUUSD'});
  const duration=Number(process.env.VOLUME_SOAK_SECONDS||120)*1000,start=Date.now();
  while(Date.now()-start<duration){
   const plans=await api('market-data/history/plans'),jobs=await api('market-data/history/volume');
   const charts=await f.evaluate(()=>Array.from({length:8},(_,i)=>({symbol:widget.chart(i).symbol(),ready:widget.chart(i).dataReady(),range:widget.chart(i).getVisibleRange(),studies:widget.chart(i).getAllStudies()})));
   assert.ok(charts.every(c=>c.ready&&c.range.to>c.range.from&&c.studies.some(s=>/volume/i.test(s.name))));
   const maintained=plans.filter(r=>['BTCUSDT','OANDA:CAD_CHF','EURUSD','XAUUSD'].includes(r.instrument));
   evidence.soak.push({elapsed_ms:Date.now()-start,charts,maintained:maintained.map(r=>({instrument:r.instrument,realtime_end:r.realtime_end,latency_ms:Date.now()-r.realtime_end,quality:r.realtime_quality})),jobs});save();
   await p.waitForTimeout(10000);
  }
  assert.ok(evidence.cold.filter(r=>r.ms<3000).length>evidence.cold.length/2,'Majority cold reads under3s');
  assert.ok(evidence.warm.every(r=>r.ms<1000),'Complete warmed native switches under1s');
  const first=evidence.soak[0],last=evidence.soak.at(-1);
  assert.ok(last.maintained.every(r=>r.latency_ms<120000),'Maintained candles must stay within120s');
  assert.ok(last.maintained.some(r=>r.realtime_end>first.maintained.find(a=>a.instrument===r.instrument).realtime_end),'Realtime must progress while backfill runs');
  assert.ok(evidence.soak.some(s=>s.jobs.some(j=>['pending','running'].includes(j.status))),'Soak must overlap real backfill work');
  assert.deepEqual(evidence.errors,[]);
  evidence.passed=true;save();await p.screenshot({path:OUT.replace('.json','.png')});
 }catch(e){evidence.error=String(e);save();throw e}finally{await b.close()}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
