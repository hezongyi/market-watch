// Real Practice observations through isolated Ubuntu workers and native callbacks.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync,execFile}=require('node:child_process');
const {createHash}=require('node:crypto');
const run=require('node:util').promisify(execFile);
const root=path.resolve(__dirname,'../..'),directory=path.join(root,'artifacts/unified-sse');
const task='mw-unified-sse-20261008',app='http://127.0.0.1:15643',chart='http://127.0.0.1:15644';
const compose=['compose','--env-file',path.join(directory,'compose.env'),'-p',task,'-f',path.join(root,'compose.unified-sse.acceptance.yaml')];
const guard=fs.readFileSync(path.join(root,'scripts/unified_sse_acceptance_fixture.py'),'utf8');
const source=`import types,sys\nm=types.ModuleType('unified_sse_acceptance_fixture')\nsys.modules[m.__name__]=m\nexec(${JSON.stringify(guard)},m.__dict__)\n`+
 fs.readFileSync(path.join(root,'scripts/unified_sse_oanda_acceptance.py'),'utf8');
async function fixture(action){const child=run('docker',[...compose,'exec','-T','api','python','-',action],{cwd:root,timeout:30000,maxBuffer:2*1024*1024});child.child.stdin.end(source);return JSON.parse((await child).stdout);}
function preflight(){assert.match(fs.readFileSync('/etc/os-release','utf8'),/^ID=ubuntu$/m);assert.ok(!process.env.DOCKER_HOST||process.env.DOCKER_HOST==='unix:///var/run/docker.sock');
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 for(const service of ['api','web','chart-origin','market-stream-worker','pricing-worker']){
  const id=execFileSync('docker',[...compose,'--profile','upstream','ps','-q',service],{cwd:root,encoding:'utf8'}).trim();assert.ok(id&&!id.includes('\n'));
  const c=JSON.parse(execFileSync('docker',['inspect',id],{encoding:'utf8'}))[0];assert.equal(c.Config.Labels['com.docker.compose.project'],task);
  const labels=JSON.parse(execFileSync('docker',['image','inspect',c.Image],{encoding:'utf8'}))[0].Config.Labels;
  for(const [k,v] of Object.entries({managed:'true',task,project:task,purpose:'acceptance',commit}))assert.equal(labels['io.market-watch.'+k],v);
 }return commit;}
const report={passed:false,synthetic:false,environment:'Ubuntu local Docker',task,checks:[],errors:[],stage:'preflight'};
const target=path.join(directory,'unified-sse-oanda-browser.json');
function persist(){fs.writeFileSync(target,JSON.stringify(report,null,2),{mode:0o600});}
const compositeMode=process.argv.includes('--composite');
const multiResources=process.argv.includes('--multi-resources');
let browser,frame,page,ownClient,pricingStopped=false,sourceTimer,sourceSampling,accountSwitched=false;
async function switchAccount(action){return run(path.join(root,'.venv/bin/python'),[path.join(root,'scripts/unified_sse_account_switch.py'),action],{cwd:root,timeout:120000});}
(async()=>{try{
 persist();report.runtime_image_commit=preflight();report.harness_sha256=createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');report.fixture_sha256=createHash('sha256').update(source).digest('hex');
 const initial=await fixture(multiResources?'resources-seed':compositeMode?'composite-activate':'seed');
 const symbol=compositeMode?'MWC:'+initial.real_history.composite:'MWP:EURUSD';
 report.series_kind=compositeMode?'composite':'provider';report.symbol=symbol;report.instrument=initial.instrument;report.stage='provider-first-screen';persist();
 if(compositeMode&&!multiResources){report.source_samples=[];sourceTimer=setInterval(()=>{
  if(sourceSampling)return;sourceSampling=fixture('state').then(s=>report.source_samples.push({at:Date.now(),
   ...s.composite_live})).catch(e=>report.errors.push(e.message)).finally(()=>{sourceSampling=null;});
 },2000);}
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>{window.__events=[];window.__feedTrace=[];
  const probe=setInterval(()=>{if(typeof feed==='undefined')return;clearInterval(probe);
   for(const name of ['getBars','subscribeBars','unsubscribeBars']){const original=feed[name];feed[name]=(...args)=>{
    window.__feedTrace.push({at:Date.now(),name,symbol:args[0]?.ticker||args[0],res:args[1]});
    if(name==='getBars'){const cb=args[3];args[3]=(rows,meta)=>{window.__feedTrace.push({at:Date.now(),name:'history-result',rows:rows.length,first:rows[0]?.time,last:rows.at(-1)?.time,meta});return cb(rows,meta);};}
    return original(...args);
   };}
  },10);
  const Native=window.EventSource;window.EventSource=class extends Native{constructor(url,options){super(url,options);if(String(url).includes('/charts/stream/events'))this.addEventListener('message',e=>window.__events.push({at:Date.now(),...JSON.parse(e.data)}));}};});
 page=await context.newPage();const requests=[];report.requests=requests;const pendingInitial=new Set();
 const initialPath=p=>['/api/charts/data','/api/market-data/quotes'].includes(p);
 page.on('requestfinished',req=>pendingInitial.delete(req));page.on('requestfailed',req=>pendingInitial.delete(req));
 page.on('pageerror',e=>report.errors.push(e.message));page.on('request',req=>{const p=new URL(req.url()).pathname;if(initialPath(p))pendingInitial.add(req);if(/^\/api\/(charts|market-data)\//.test(p))requests.push({at:Date.now(),path:p});});
 await page.goto(app+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(directory,'login.json'))).password);await page.getByRole('button',{name:'登录工作台'}).click();
 await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
 await page.goto(app+'/advanced-charts');await expect.poll(()=>page.frames().some(f=>f.url().startsWith(chart+'/')),{timeout:30000}).toBe(true);
 frame=page.frames().find(f=>f.url().startsWith(chart+'/'));
 await frame.waitForFunction(symbol=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady()&&MWSeries.same(widget.activeChart().symbol(),symbol),symbol,{timeout:120000});
 if(multiResources) {
  report.stage='multi-composite-initialization';persist();
  assert.notEqual(initial.resources_composite,initial.real_history.composite);
  await frame.evaluate(()=>{
   window.__bars=[];const original=feed.subscribeBars;
   feed.subscribeBars=(s,res,cb,id,reset)=>original(s,res,b=>{cb(b);window.__bars.push({at:Date.now(),ticker:s.ticker,res,...b});},id,reset);
   for(const sub of subscriptions.values()){const cb=sub.cb;sub.cb=b=>{cb(b);window.__bars.push({at:Date.now(),ticker:sub.symbol,res:sub.res,...b});};}
   widget.setLayout('4');
  });
  await frame.waitForFunction(()=>widget.chartsCount()===4,null,{timeout:30000});
  const tickers=[symbol,symbol,'MWC:'+initial.resources_composite,'MWC:'+initial.resources_composite],resolutions=['1W','1M','1W','1M'];
  await frame.evaluate(async({tickers,resolutions})=>{for(let i=0;i<4;i++){
   await widget.chart(i).setSymbol(tickers[i]);
   await widget.chart(i).setResolution(resolutions[i],{doNotActivateChart:true});
  }},{tickers,resolutions});
  await frame.waitForFunction(({tickers,resolutions})=>tickers.every((t,i)=>MWSeries.same(widget.chart(i).symbol(),t)&&widget.chart(i).resolution()===resolutions[i]&&widget.chart(i).dataReady()),{tickers,resolutions},{timeout:180000});
  await frame.evaluate(()=>{for(const id of [...quoteSubscriptions.keys()])feed.unsubscribeQuotes(id);});
  report.measurement_windows=[];
  for(let i=0;i<2;i++){
   const phase=Date.now()%60000;await page.waitForTimeout(phase<7000?7000-phase:67000-phase);
   await expect.poll(()=>pendingInitial.size===0,{timeout:60000}).toBe(true);
   const started=Date.now();
   const output=await run(path.join(root,'.venv/bin/python'),[path.join(root,'scripts/unified_sse_resources.py'),'--scenario','real-two-composites-w1-mn-stable-'+i,'--seconds','16','--interval','4'],{cwd:root,timeout:60000,maxBuffer:3*1024*1024});
   const bars=await frame.evaluate(at=>window.__bars.filter(b=>b.at>=at),started);
   assert.ok(tickers.every((t,index)=>bars.some(b=>b.res===resolutions[index]&&b.ticker.toLowerCase()===t.toLowerCase())),'Every composite/period must receive actual native callbacks');
   assert.ok(!requests.some(r=>r.at>=started&&initialPath(r.path)),'Stable multi-composite window must not reload history or quotes');
   report.measurement_windows.push({started,callbacks:bars.length,resources:JSON.parse(output.stdout)});
  }
  report.checks.push('two real composites each W1/MN deliver native callbacks; two stable windows measured CPU/memory/DB/network/queue with no market HTTP');
  report.passed=true;return;
 }
 ownClient=await frame.evaluate(()=>clientId);
 await frame.evaluate(()=>{window.__bars=[];window.__quotes=[];});
 if(!process.argv.includes('--account-switch')) {
 await frame.waitForFunction(()=>[...subscriptions.values()].some(s=>s.marketListener&&!s.marketRecovering),null,{timeout:60000});
 await expect.poll(()=>pendingInitial.size===0&&Date.now()-Math.max(0,...requests.filter(r=>
  initialPath(r.path)).map(r=>r.at))>=16000,{timeout:60000}).toBe(true);
 await frame.evaluate(()=>{window.__bars=[];window.__quotes=[];for(const s of subscriptions.values()){const cb=s.cb;s.cb=b=>{cb(b);window.__bars.push({at:Date.now(),ticker:s.symbol,res:s.res,...b});};}});
 const stable=Date.now();await frame.waitForFunction(()=>window.__bars.length>=2,null,{timeout:70000});
 report.provider_bars=await frame.evaluate(()=>window.__bars);report.checks.push(compositeMode?'real Practice fixed M1 history and stream-backed composite update licensed chart through SSE':'real Practice REST native M1 bars update actual licensed chart through SSE');
 report.provider_measurement_start=stable;
 assert.ok(!requests.some(r=>r.at>=stable&&['/api/charts/data','/api/market-data/quotes','/api/charts/provider/latest'].includes(r.path)),'Provider normal updates do not poll from browser');
 if(process.argv.includes('--first-screen')){report.passed=true;report.checks.push('real composite first screen receives bars after idle without a period switch');return;}
 }
 report.stage='quote-only';persist();
 await frame.evaluate(instrument=>{for(const id of [...subscriptions.keys()])feed.unsubscribeBars(id);feed.subscribeQuotes([instrument],[],rows=>window.__quotes.push({at:Date.now(),rows}),'oanda-acceptance');},compositeMode?symbol:initial.instrument);
 await expect.poll(async()=>{const s=await fixture('state');return s.live.ready&&s.consumers.some(c=>c.client===ownClient&&c.kind==='quotes')&&!s.consumers.some(c=>c.client===ownClient&&c.kind==='bars');},{timeout:120000}).toBe(true);
 const quoteStart=Date.now();await frame.waitForFunction(start=>new Set(window.__quotes.filter(q=>q.at>=start)
  .flatMap(q=>q.rows.filter(r=>Number.isFinite(r.v.lp)).map(r=>r.v.description))).size>=2,quoteStart,{timeout:150000});
 report.quote_only=await frame.evaluate(()=>window.__quotes);report.checks.push('real supplier demand with all bars closed keeps native quote callback delivery');
 if(compositeMode && process.argv.includes('--owner-restart')) {
  await frame.waitForFunction(()=>window.__quotes.at(-1)?.rows.some(r=>r.v.quote_ready===true &&
   r.v.price_type==='sampled_bid'),null,{timeout:30000});
  const stoppedAt=Date.now();
  await run('docker',[...compose,'stop','-t','5','pricing-worker'],{cwd:root,timeout:30000});pricingStopped=true;
  await frame.waitForFunction(at=>window.__quotes.some(q=>q.at>=at&&q.rows.some(r=>
   r.v.quote_ready===false&&r.v.price_type!=='sampled_bid')),stoppedAt,{timeout:45000});
  report.owner_failure=await frame.evaluate(at=>window.__quotes.filter(q=>q.at>=at),stoppedAt);
  await run('docker',[...compose,'start','pricing-worker'],{cwd:root,timeout:30000});pricingStopped=false;
  const restartedAt=Date.now();
  await frame.waitForFunction(at=>window.__quotes.some(q=>q.at>=at&&q.rows.some(r=>
   r.v.quote_ready===true&&r.v.price_type==='sampled_bid')),restartedAt,{timeout:120000});
  report.owner_recovery=await frame.evaluate(at=>window.__quotes.filter(q=>q.at>=at),restartedAt);
  report.checks.push('real pricing worker stop retracts sampled-BID readiness; restart restores actual source prices');
 }
 if(compositeMode && process.argv.includes('--account-switch')) {
  clearInterval(sourceTimer);await sourceSampling;
  const before=await fixture('account-state');report.stage='account-switch';persist();
  const at=Date.now();accountSwitched=true;await switchAccount('switch');
  await expect.poll(async()=>{try{return (await fixture('account-state')).different_account;}catch{return false;}},{timeout:120000}).toBe(true);
  const switched=await fixture('account-state');
  assert.equal(switched.immutable_fingerprint,before.immutable_fingerprint);
  assert.deepEqual(switched.old_live,{current_account:false,owned:false,quote_ready:false});
  assert.equal(switched.old_snapshot.quality,'account_changed');
  await frame.waitForFunction(at=>window.__quotes.some(q=>q.at>=at&&q.rows.some(r=>r.v.quality==='account_changed'&&r.v.quote_ready===false&&r.v.price_type!=='sampled_bid')),at,{timeout:90000});
  await frame.evaluate(instrument=>feed.subscribeQuotes([instrument],[],rows=>window.__quotes.push({at:Date.now(),rows}),'oanda-alternate-account'),switched.current_instrument);
  await expect.poll(async()=>{const s=await fixture('account-state');return s.current_received_at>switched.current_received_at&&s.current_ready;},{timeout:150000}).toBe(true);
  await frame.waitForFunction(instrument=>window.__quotes.some(q=>q.rows.some(r=>MWSeries.same(r.n,instrument)&&Number.isFinite(r.v.lp))),switched.current_instrument,{timeout:90000});
  const received=await fixture('account-state');
  assert.equal(received.old_received_at,switched.old_received_at);
  assert.equal(received.immutable_fingerprint,before.immutable_fingerprint);
  report.account_switch={before,switched,received};
  await frame.evaluate(()=>feed.unsubscribeQuotes('oanda-alternate-account'));
  const restoredAt=Date.now();await switchAccount('restore');accountSwitched=false;
  await expect.poll(async()=>{try{return !(await fixture('account-state')).different_account;}catch{return false;}},{timeout:120000}).toBe(true);
  await frame.waitForFunction(at=>window.__quotes.some(q=>q.at>=at&&q.rows.some(r=>r.v.quote_ready===true&&r.v.price_type==='sampled_bid')),restoredAt,{timeout:150000});
  report.account_switch.restored=await fixture('account-state');
  assert.equal(report.account_switch.restored.immutable_fingerprint,before.immutable_fingerprint);
  report.checks.push('real alternate Practice account delivers separately; original history/identity preserved, old account sampled prices fenced, original account restored');
 }
 await fixture('watch-on');
 await frame.evaluate(()=>{for(const id of [...quoteSubscriptions.keys()])feed.unsubscribeQuotes(id);});
 await expect.poll(async()=>!(await fixture('state')).consumers.some(c=>c.client===ownClient),{timeout:15000}).toBe(true);
 const before=await fixture('state');report.stage='independent-alert';persist();
 await expect.poll(async()=>{const s=await fixture('state');report.independent_alert={before,after:s};return s.desired_symbols.includes('EUR_USD')&&s.live.received_at>before.live.received_at&&JSON.stringify(s.watch_state)!==JSON.stringify(before.watch_state);},{timeout:45000}).toBe(true);
 report.checks.push('after final browser cancellation real OANDA prices and tick rule evaluation continue for independent active watch');
 await fixture('watch-off');await expect.poll(async()=>!(await fixture('state')).desired_symbols.includes('EUR_USD'),{timeout:130000}).toBe(true);report.checks.push('last independent demand release removes real source from desired acquisition');
 report.requests=requests;report.stream=await page.evaluate(()=>window.__events);assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.error=String(e);if(frame)report.native_state=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),subscriptions:[...subscriptions.values()].map(s=>({symbol:s.symbol,res:s.res,last:s.last,recovering:s.marketRecovering,paused:s.marketPaused})),quotes:[...quoteSubscriptions.values()].map(s=>({symbols:s.symbols}))})).catch(()=>null);if(page)report.stream=await page.evaluate(()=>window.__events).catch(()=>[]);throw e;
}finally{clearInterval(sourceTimer);await sourceSampling;if(accountSwitched)await switchAccount('restore');if(pricingStopped)await run('docker',[...compose,'start','pricing-worker'],{cwd:root,timeout:30000}).catch(()=>{});if(frame){report.feed_trace=await frame.evaluate(()=>window.__feedTrace).catch(()=>[]);await frame.evaluate(()=>{for(const id of [...subscriptions.keys()])feed.unsubscribeBars(id);for(const id of [...quoteSubscriptions.keys()])feed.unsubscribeQuotes(id);}).catch(()=>{});}await fixture('watch-off').catch(()=>{});if(browser)await browser.close();persist();}
console.log(JSON.stringify({passed:report.passed,checks:report.checks}));})().catch(e=>{console.error(e.message);process.exitCode=1;});
