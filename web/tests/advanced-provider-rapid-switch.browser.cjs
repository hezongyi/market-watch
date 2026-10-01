// Immediate cold cross-period demand and actual overlapping public setResolution calls.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
const output=process.env.RAPID_SWITCH_OUTPUT||'/tmp/mw-provider-rapid-switch.json';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const errors=[],http=[],samples=[],starts=new Map();let phase='login',activeFrame;
 page.on('pageerror',error=>errors.push({phase,message:error.message,stack:error.stack}));
 page.on('request',request=>{if(request.url().includes('/api/charts/data'))starts.set(request,Date.now())});
 page.on('response',async response=>{
  const started=starts.get(response.request());if(!started)return;
  const body=await response.json().catch(()=>({}));http.push({phase,elapsed_ms:Date.now()-started,status:response.status(),query:response.request().postDataJSON(),count:body.bars?.length,cache_hit:body.cache_hit,timings_ms:body.timings_ms});
 });
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body})}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  for(const symbol of process.env.RAPID_SWITCH_SYMBOLS?JSON.parse(process.env.RAPID_SWITCH_SYMBOLS):['MWP:OANDA:AUD_CAD','MWP:BTCUSDT']){
   await page.goto(APP+'/');
   execFileSync('../.venv/bin/python',['../scripts/provider_acceptance_fixture.py','--reset'],{env:{...process.env,PYTHONPATH:'../backend'},timeout:45000});
   const w=await api('advanced-charts/workspaces',{name:'首屏即时与连续切换 '+symbol});
   await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,document:{engine:'tv31',schemaVersion:1,symbol,series_kind:'provider',interval:'5'}});
   phase=symbol+' initial';const began=Date.now();await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
   const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
   activeFrame=frame;
   await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});
   const initial_ms=Date.now()-began;
   // No wait for background warming. Chosen independently for each source.
   const resolution=symbol.includes('BTC')?'15':'60';phase=symbol+' immediate';const switched=Date.now();
   await frame.evaluate(resolution=>widget.activeChart().setResolution(resolution,{doNotActivateChart:true}),resolution);
   await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:30000});
   const immediate_ms=Date.now()-switched;
   assert.equal(await frame.evaluate(()=>widget.activeChart().resolution()),resolution);
   phase=symbol+' cold burst';const coldBurstStarted=Date.now();
   if(process.env.RAPID_TRACE==='1')await frame.evaluate(()=>{
    globalThis.rapidTrace=[];
    for(const name of ['getBars','resolveSymbol']) {
     const original=feed[name];
     feed[name]=function(...args){rapidTrace.push({name,at:Date.now(),ticker:args[0]?.ticker||args[0],resolution:name==='getBars'?args[1]:null});
      if(name==='getBars')for(const index of [3,4]){const cb=args[index];args[index]=(...values)=>{rapidTrace.push({name:name+' callback '+index,at:Date.now(),value:index===4?String(values[0]):values[0]?.length});return cb(...values)}}
      return original.apply(this,args);
     };
    }
   });
   if(process.env.RAPID_SEQUENCE)await frame.evaluate(sequence=>globalThis.rapidSequence=sequence,process.env.RAPID_SEQUENCE);
   const coldBurst=await frame.evaluate(async()=>{
    const c=widget.activeChart(),attempts=[],pending=[];
    const sequence=JSON.parse(globalThis.rapidSequence||'null')||['1W','1','240','1M','30','1D','5','60','15','1W','1M','240','30','1','1D','60','15','5','240','1'];
    for(const res of sequence){
     pending.push(c.setResolution(res,{doNotActivateChart:true}).then(value=>attempts.push({resolution:res,value}),error=>attempts.push({resolution:res,error:String(error)})));
     await new Promise(resolve=>setTimeout(resolve,80));
    }
    await Promise.all(pending);return {attempts,expected:sequence.at(-1)};
   });
   await frame.waitForFunction(()=>widget.activeChart().dataReady()&&pending.size===0&&!loading,null,{timeout:Number(process.env.RAPID_SETTLE_MS||60000)});
   assert.equal(await frame.evaluate(()=>widget.activeChart().resolution()),coldBurst.expected);
   assert.ok(!coldBurst.attempts.some(a=>a.error),'cold overlapping changes must settle without rejected promises');
   const cold_burst_ms=Date.now()-coldBurstStarted;
   if(process.env.RAPID_ONLY_COLD==='1') {
    samples.push({symbol,initial_ms,immediate_ms,cold_burst_ms,coldBurst});continue;
   }
   const sequential=[];
   for(const res of ['1W','240','1','1M','30','1D','5','15','60']){
    phase=symbol+' sequential '+res;const started=Date.now();
    await frame.evaluate(res=>widget.activeChart().setResolution(res,{doNotActivateChart:true}),res);
    await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:30000});
    sequential.push({resolution:res,elapsed_ms:Date.now()-started});
   }
   phase=symbol+' burst';const burstStarted=Date.now();
   const burst=await frame.evaluate(async()=>{
    const c=widget.activeChart(),attempts=[],pending=[];
    const sequence=['1','5','1D','15','1W','30','240','1M','60','5','1D','1','30','1W','15','240','60','1M','5','1'];
    for(const res of sequence){
     const started=Date.now();
     pending.push(c.setResolution(res,{doNotActivateChart:true}).then(value=>attempts.push({resolution:res,value,elapsed_ms:Date.now()-started}),error=>attempts.push({resolution:res,error:String(error)})));
     await new Promise(resolve=>setTimeout(resolve,80));
    }
    await Promise.all(pending);return {attempts,expected:sequence.at(-1)};
   });
   await frame.waitForFunction(()=>widget.activeChart().dataReady()&&pending.size===0&&!loading,null,{timeout:60000});
   const state=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),range:widget.activeChart().getVisibleRange(),pending:pending.size}));
   assert.equal(state.symbol,symbol);assert.equal(state.resolution,burst.expected);assert.ok(state.range.to>state.range.from);
   assert.ok(!burst.attempts.some(a=>a.error),'overlapping public resolution changes must settle without rejected promises');
   samples.push({symbol,initial_ms,immediate_resolution:resolution,immediate_ms,cold_burst_ms,coldBurst,sequential,burst_elapsed_ms:Date.now()-burstStarted,burst,state});
   fs.writeFileSync(output,JSON.stringify({passed:false,samples,errors,http},null,2));console.log('SAMPLE',JSON.stringify(samples.at(-1)));
  }
  assert.deepEqual(errors,[]);
  assert.ok(http.every(r=>r.status===200),'all completed data responses succeed');
  if(process.env.RAPID_CHECK_DISPLAY_SLO==='1')for(const sample of samples){
   assert.ok(sample.initial_ms<3000,`${sample.symbol} initial display ${sample.initial_ms}ms exceeds 3s`);
   assert.ok(sample.immediate_ms<3000,`${sample.symbol} immediately selected cold period ${sample.immediate_ms}ms exceeds 3s`);
  }
  fs.writeFileSync(output,JSON.stringify({passed:true,samples,errors,http},null,2));
 }catch(error){
  const observed=await activeFrame?.evaluate(()=>({ready,loading,resolution:widget.activeChart().resolution(),dataReady:widget.activeChart().dataReady(),
   pending:[...pending.keys()],queue:requests.length,history:[...lastHistory],trace:globalThis.rapidTrace,subscriptions:[...subscriptions.values()].map(s=>({symbol:s.symbol,res:s.res,last:s.last}))})).catch(()=>null);
  fs.writeFileSync(output,JSON.stringify({passed:false,error:String(error),phase,samples,errors,http,observed},null,2));throw error}
 finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
