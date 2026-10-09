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
let browser,frame,page,ownClient;
(async()=>{try{
 persist();report.runtime_image_commit=preflight();report.harness_sha256=createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');report.fixture_sha256=createHash('sha256').update(source).digest('hex');
 const initial=await fixture(compositeMode?'composite-activate':'seed');
 const symbol=compositeMode?'MWC:'+initial.real_history.composite:'MWP:EURUSD';
 report.series_kind=compositeMode?'composite':'provider';report.symbol=symbol;report.instrument=initial.instrument;report.stage='provider-first-screen';persist();
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>{window.__events=[];const Native=window.EventSource;window.EventSource=class extends Native{constructor(url,options){super(url,options);if(String(url).includes('/charts/stream/events'))this.addEventListener('message',e=>window.__events.push({at:Date.now(),...JSON.parse(e.data)}));}};});
 page=await context.newPage();const requests=[];report.requests=requests;const pendingInitial=new Set();
 const initialPath=p=>['/api/charts/data','/api/market-data/quotes'].includes(p);
 page.on('requestfinished',req=>pendingInitial.delete(req));page.on('requestfailed',req=>pendingInitial.delete(req));
 page.on('pageerror',e=>report.errors.push(e.message));page.on('request',req=>{const p=new URL(req.url()).pathname;if(initialPath(p))pendingInitial.add(req);if(/^\/api\/(charts|market-data)\//.test(p))requests.push({at:Date.now(),path:p});});
 await page.goto(app+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(directory,'login.json'))).password);await page.getByRole('button',{name:'登录工作台'}).click();
 await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
 await page.goto(app+'/advanced-charts');await expect.poll(()=>page.frames().some(f=>f.url().startsWith(chart+'/')),{timeout:30000}).toBe(true);
 frame=page.frames().find(f=>f.url().startsWith(chart+'/'));
 await frame.waitForFunction(symbol=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady()&&widget.activeChart().symbol()===symbol,symbol,{timeout:120000});
 await frame.waitForFunction(()=>[...subscriptions.values()].some(s=>s.marketListener&&!s.marketRecovering),null,{timeout:60000});ownClient=await frame.evaluate(()=>clientId);
 await expect.poll(()=>pendingInitial.size===0&&Date.now()-Math.max(0,...requests.filter(r=>
  initialPath(r.path)).map(r=>r.at))>=16000,{timeout:60000}).toBe(true);
 await frame.evaluate(()=>{window.__bars=[];window.__quotes=[];for(const s of subscriptions.values()){const cb=s.cb;s.cb=b=>{cb(b);window.__bars.push({at:Date.now(),ticker:s.symbol,res:s.res,...b});};}});
 const stable=Date.now();await frame.waitForFunction(()=>window.__bars.length>=2,null,{timeout:70000});
 report.provider_bars=await frame.evaluate(()=>window.__bars);report.checks.push(compositeMode?'real Practice fixed M1 history and stream-backed composite update licensed chart through SSE':'real Practice REST native M1 bars update actual licensed chart through SSE');
 report.provider_measurement_start=stable;
 assert.ok(!requests.some(r=>r.at>=stable&&['/api/charts/data','/api/market-data/quotes','/api/charts/provider/latest'].includes(r.path)),'Provider normal updates do not poll from browser');
 report.stage='quote-only';persist();
 await frame.evaluate(instrument=>{for(const id of [...subscriptions.keys()])feed.unsubscribeBars(id);feed.subscribeQuotes([instrument],[],rows=>window.__quotes.push({at:Date.now(),rows}),'oanda-acceptance');},compositeMode?symbol:initial.instrument);
 await expect.poll(async()=>{const s=await fixture('state');return s.live.ready&&s.consumers.some(c=>c.client===ownClient&&c.kind==='quotes')&&!s.consumers.some(c=>c.client===ownClient&&c.kind==='bars');},{timeout:120000}).toBe(true);
 const quoteStart=Date.now();await frame.waitForFunction(start=>new Set(window.__quotes.filter(q=>q.at>=start)
  .flatMap(q=>q.rows.filter(r=>Number.isFinite(r.v.lp)).map(r=>r.v.description))).size>=2,quoteStart,{timeout:150000});
 report.quote_only=await frame.evaluate(()=>window.__quotes);report.checks.push('real supplier demand with all bars closed keeps native quote callback delivery');
 await fixture('watch-on');
 await frame.evaluate(()=>{for(const id of [...quoteSubscriptions.keys()])feed.unsubscribeQuotes(id);});
 await expect.poll(async()=>!(await fixture('state')).consumers.some(c=>c.client===ownClient),{timeout:15000}).toBe(true);
 const before=await fixture('state');report.stage='independent-alert';persist();
 await expect.poll(async()=>{const s=await fixture('state');report.independent_alert={before,after:s};return s.desired_symbols.includes('EUR_USD')&&s.live.received_at>before.live.received_at&&JSON.stringify(s.watch_state)!==JSON.stringify(before.watch_state);},{timeout:45000}).toBe(true);
 report.checks.push('after final browser cancellation real OANDA prices and tick rule evaluation continue for independent active watch');
 await fixture('watch-off');await expect.poll(async()=>!(await fixture('state')).desired_symbols.includes('EUR_USD'),{timeout:15000}).toBe(true);report.checks.push('last independent demand release removes real source from desired acquisition');
 report.requests=requests;report.stream=await page.evaluate(()=>window.__events);assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.error=String(e);if(frame)report.native_state=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),subscriptions:[...subscriptions.values()].map(s=>({symbol:s.symbol,res:s.res,last:s.last,recovering:s.marketRecovering,paused:s.marketPaused})),quotes:[...quoteSubscriptions.values()].map(s=>({symbols:s.symbols}))})).catch(()=>null);if(page)report.stream=await page.evaluate(()=>window.__events).catch(()=>[]);throw e;
}finally{if(frame)await frame.evaluate(()=>{for(const id of [...subscriptions.keys()])feed.unsubscribeBars(id);for(const id of [...quoteSubscriptions.keys()])feed.unsubscribeQuotes(id);}).catch(()=>{});await fixture('watch-off').catch(()=>{});if(browser)await browser.close();persist();}
console.log(JSON.stringify({passed:report.passed,checks:report.checks}));})().catch(e=>{console.error(e.message);process.exitCode=1;});
