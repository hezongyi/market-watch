// Native acceptance runner. Run only after the user authorizes acceptance.
// Faults and saves are scoped to this disposable browser context; never seed,
// delete snapshots, mark messages read, or change the protected browser profile.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {readOnlyAcceptance}=require('./helpers/readOnlyAcceptance.cjs');
for(const name of ['MW_TEST_BASE_URL','MW_TEST_CHART_URL','MW_TEST_CREDENTIALS_FILE','MW_TEST_ARTIFACT_DIR'])
 if(!process.env[name])throw Error(name+' is required');
const base=new URL(process.env.MW_TEST_BASE_URL).origin,chartOrigin=new URL(process.env.MW_TEST_CHART_URL).origin;
const credentials=JSON.parse(fs.readFileSync(process.env.MW_TEST_CREDENTIALS_FILE));
const output=path.resolve(process.env.MW_TEST_ARTIFACT_DIR);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report={base,chartOrigin,boundary:'real application, PG and native charts; browser-only fault injection; no persistent settings/notification writes',cases:[],passed:false};
fs.mkdirSync(output,{recursive:true});
(async()=>{
 // Only this temporary browser uses the loopback proxy. Cutting its CONNECT
 // sockets interrupts established SSE without changing the host network or API.
 const net=require('node:net'),http=require('node:http'),tunnels=new Set();let networkDown=false;
 const proxy=http.createServer((req,res)=>{res.writeHead(502);res.end();});
 proxy.on('connect',(req,socket,head)=>{
   if(networkDown){socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return;}
   const address=new URL('http://'+req.url),upstream=net.connect(Number(address.port)||443,address.hostname);
   tunnels.add(socket);tunnels.add(upstream);
   for(const s of [socket,upstream]){s.on('close',()=>tunnels.delete(s));s.on('error',()=>{socket.destroy();upstream.destroy();});}
   upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,proxy:{server:'http://127.0.0.1:'+proxy.address().port}});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:1000}});
 let holdInstrument=null,releaseHold,held=false,compareMismatch=false,targetInstrument,comparisonPage;
 let gate=new Promise(resolve=>releaseHold=resolve);
 await context.addInitScript(()=>{
   globalThis.acceptanceStates=[];globalThis.acceptanceTransport=[];
   addEventListener('message',({data:m})=>{if(m?.channel==='mw-chart-v1' && m.type==='chart-indicator-state')
     acceptanceStates.push({index:m.index,id:m.id,state:m.state,epoch:m.epoch});});
   const Native=EventSource;
   globalThis.EventSource=class extends Native{
     constructor(...args){super(...args);for(const event of ['open','error'])this.addEventListener(event,()=>{
       const record={event,readyState:this.readyState,at:Date.now()};
       acceptanceTransport.push(record);
       if(window!==window.top)window.top.postMessage({channel:'mw-acceptance-transport',record},'*');
     });}
   };
   addEventListener('message',({data:m})=>{if(m?.channel==='mw-acceptance-transport')acceptanceTransport.push(m.record);});
 });
 await readOnlyAcceptance(context,report);
 await context.route('**/api/charts/history-loads',async route=>{
   const q=route.request().postDataJSON()?.query;
   if(q?.instrument===holdInstrument&&!q.indicators?.length){held=true;await gate;}
   return route.continue();
 });
 await context.route('**/api/charts/data',async route=>{
   const q=route.request().postDataJSON();
   if(q.instrument===holdInstrument&&!q.indicators?.length){held=true;await gate;}
   if(compareMismatch&&q.instrument===targetInstrument&&!q.indicators?.length){
     compareMismatch=false;
     const json=structuredClone(comparisonPage);
     assert(Number.isSafeInteger(json.cache_revision));json.cache_revision++;
     return route.fulfill({json});
   }
   return route.continue();
 });
 const page=await context.newPage(),errors=[];
 page.on('console',m=>{if(m.text().startsWith('display-snapshot-recovery'))console.log(m.text());});
 page.on('pageerror',error=>errors.push(error.message));
 try{
   await page.goto(base+'/advanced-charts/mw75-real');
   await page.getByLabel('管理员密码').fill(credentials.login_password);
   await page.locator('button.auth-submit').click();
   await expect.poll(()=>page.frames().some(f=>f.url().startsWith(chartOrigin+'/?')),{timeout:90000}).toBe(true);
   const host=page.frames().find(f=>f.url().startsWith(chartOrigin+'/?'));
   await host.waitForFunction(()=>typeof widget!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:120000});
   assert.equal(await host.evaluate(()=>typeof resumeDeferredDisplayRecoveries),'function','deploy the approved candidate before running acceptance');
   await host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('2h');});
   await host.waitForFunction(()=>widget.chartsCount()===2,null,{timeout:60000});
   await host.evaluate(async()=>{const c=widget.chart(0);await new Promise(r=>c.setSymbol('MWP:OANDA:EUR_USD',r));await new Promise(r=>c.setResolution('1D',r));});
   const index=1;
   await host.evaluate(async({index,symbol})=>{
     const c=widget.chart(index);c.removeAllStudies();await new Promise(resolve=>c.setSymbol(symbol,resolve));
     await new Promise(resolve=>c.setResolution('1D',resolve));
     for(const name of ['SWING_SR_V1','SUPERTREND_PINE_V1','RSI'])await c.createStudy('守望 Python '+name,false,false);
   },{index,symbol:process.env.MW_TEST_PROVIDER_SYMBOL||'MWP:OANDA:XAU_USD'});
   await host.waitForFunction(index=>widget.chart(index).dataReady()&&widget.chart(index).getAllStudies().length>=3,index,{timeout:120000});
   targetInstrument=await host.evaluate(index=>decode(widget.chart(index).symbol()).symbol,index);
   const settings=()=>host.evaluate(index=>{const c=widget.chart(index);return {
     studies:c.getAllStudies().map(({id})=>({id,inputs:c.getStudyById(id).getInputValues(),styles:c.getStudyById(id).getStyleValues()})),
     range:c.getVisibleRange(),origin:indicatorBindings.get(indicatorKey(c.symbol(),c.resolution()))?.calculationStart};},index);
   await host.waitForFunction(()=>!historyReloading&&!loading&&pending.size===0&&requests.length===0&&!MWNativeNavigation?.busy()&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:60000});
   comparisonPage=await host.evaluate(async index=>{const c=widget.chart(index),rows=providerRecoveryRows(c);return query(c.symbol(),c.resolution(),{before:rows.at(-1)[0]*1000+1,limit:rows.length,indicators:[]},Date.now()+30000);},index);
   const before=await settings();console.log('READY two charts and three target studies',Date.now());
   holdInstrument=await host.evaluate(()=>decode(widget.chart(0).symbol()).symbol);
   assert.notEqual(holdInstrument,targetInstrument,'choose two distinct price series for the busy test');
   await host.evaluate(()=>{globalThis.acceptanceOther=reloadHistory(widget.chart(0).symbol(),widget.chart(0).resolution(),()=>true,true).then(result=>globalThis.acceptanceOtherResult=result);});
   try{await expect.poll(()=>held,{timeout:20000}).toBe(true);}catch(e){report.other=await host.evaluate(()=>({result:globalThis.acceptanceOtherResult,busy:historyReloading}));throw e;}
   console.log('HELD actual other-chart history HTTP',Date.now());
   // Missing token and revision mismatch are browser fixtures; actual price
   // requests and native chart recovery still use the deployed application.
   compareMismatch=true;
   await host.evaluate(index=>{
     const c=widget.chart(index),key=indicatorKey(c.symbol(),c.resolution()),token='0'.repeat(64);
     indicatorBindings.get(key).providerSnapshot=token;
     globalThis.acceptanceRecovery=recoverDisplaySnapshot(c.symbol(),c.resolution(),token,false,{reason:'missing'});
   },index);
   await host.waitForFunction(index=>displayRecoveries.get(indicatorKey(widget.chart(index).symbol(),'1D'))?.state==='deferred',index);
   console.log('DEFERRED',Date.now());await page.waitForTimeout(3500);
   const waiting=await host.evaluate(index=>{const e=displayRecoveries.get(indicatorKey(widget.chart(index).symbol(),'1D'));return {state:e.state,attempts:e.attempts};},index);
   assert.equal(waiting.state,'deferred');assert.equal(waiting.attempts,0);
   holdInstrument=null;releaseHold();console.log('RELEASE',Date.now());
   await host.evaluate(async()=>{await acceptanceOther;await acceptanceRecovery;});
   await host.waitForFunction(index=>displayRecoveries.get(indicatorKey(widget.chart(index).symbol(),'1D'))?.state==='ready',index,{timeout:120000});
   await expect.poll(async()=>{const states=await page.evaluate(()=>acceptanceStates);return states.filter(s=>s.index===index&&s.state==='ready'&&!s.id.startsWith('display-snapshot:')).length;},{timeout:120000}).toBeGreaterThanOrEqual(3);
   const after=await settings();assert.equal(hash(after.studies),hash(before.studies));assert.equal(after.origin,before.origin);
   assert(Math.abs(after.range.from-before.range.from)<86400&&Math.abs(after.range.to-before.range.to)<86400);
   report.cases.push('real multi-chart reload held >3s; zero deferred failures; price and three dependent indicators restored with settings/origin/range retained');
   console.log('RESTORED price and three studies; settings/range/origin retained',Date.now());
   report.transportBefore=await page.evaluate(()=>acceptanceTransport);
   await page.screenshot({path:path.join(output,'confirmation-snapshot-native.png')});
   // Native document reload may cancel by credential replacement, rather than
   // workspace epoch. Record the actual protection reason; VM coverage tests
   // stale_native_generation explicitly. The timeframe case removes a viewer.
   for(const kind of ['workspace','timeframe']){
     report.stage='cancel '+kind;
     await host.waitForFunction(()=>!historyReloading&&!loading&&pending.size===0&&requests.length===0&&!MWNativeNavigation?.busy()&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:60000});
     await host.evaluate(()=>new Promise(resolve=>widget.save(document=>{globalThis.acceptanceSaved=document;resolve();})));
     comparisonPage=await host.evaluate(async index=>{const c=widget.chart(index),rows=providerRecoveryRows(c);return query(c.symbol(),c.resolution(),{before:rows.at(-1)[0]*1000+1,limit:rows.length,indicators:[]},Date.now()+30000);},index);
     gate=new Promise(resolve=>releaseHold=resolve);held=false;
     holdInstrument=await host.evaluate(()=>decode(widget.chart(0).symbol()).symbol);
     await host.evaluate(()=>{globalThis.acceptanceOther=reloadHistory(widget.chart(0).symbol(),widget.chart(0).resolution(),()=>true,true).catch(error=>({status:'cancelled',error:String(error)}));});
     await expect.poll(()=>held,{timeout:20000}).toBe(true);compareMismatch=true;
     await host.evaluate(({index,kind})=>{
       const c=widget.chart(index),key=indicatorKey(c.symbol(),c.resolution()),token=(kind==='workspace'?'0':'1').repeat(64);
       indicatorBindings.get(key).providerSnapshot=token;
       globalThis.acceptanceRecovery=recoverDisplaySnapshot(c.symbol(),c.resolution(),token,false,{reason:'missing'});
       globalThis.acceptanceCancelledEntry=displayRecoveries.get(key);
     },{index,kind});
     await host.waitForFunction(()=>acceptanceCancelledEntry?.state==='deferred',null,{timeout:30000});
     await host.evaluate(({kind,index})=>{if(kind==='workspace')widget.load(acceptanceSaved);else widget.chart(index).setResolution('240',()=>{});},{kind,index});
     await host.waitForFunction(()=>acceptanceCancelledEntry.state==='cancelled',null,{timeout:15000});
     holdInstrument=null;releaseHold();
     await host.evaluate(async()=>{await acceptanceOther;await acceptanceRecovery;});
     const cancelled=await host.evaluate(()=>({state:acceptanceCancelledEntry.state,attempts:acceptanceCancelledEntry.attempts,reason:acceptanceCancelledEntry.evidence.cancel_reason}));
     assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.attempts,0);
     assert(['stale_native_generation','viewer_removed','credential_superseded'].includes(cancelled.reason));
     (report.cancellations ||= []).push({kind,...cancelled});
     report.cases.push('deferred recovery cancelled after native '+kind+' change without a reload attempt ('+cancelled.reason+')');
     console.log('CANCELLED',kind,JSON.stringify(cancelled));
     await host.waitForFunction(()=>ready&&!loading&&Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:120000});
   }
   const count=await page.evaluate(()=>acceptanceTransport.length);
   report.stage='SSE offline error';
   networkDown=true;for(const socket of tunnels)socket.destroy();
   await expect.poll(()=>page.evaluate(count=>acceptanceTransport.slice(count).some(e=>e.event==='error'),count),{timeout:30000}).toBe(true);
   report.stage='SSE online reopen';
   networkDown=false;
   await expect.poll(()=>page.evaluate(count=>acceptanceTransport.slice(count).some(e=>e.event==='open'),count),{timeout:45000}).toBe(true);
   report.cases.push('real browser SSE interruption and reopen; native retry semantics retained');
   report.transport=await page.evaluate(()=>acceptanceTransport.map(e=>({...e})));
   report.blockedWritesCount=(report.blockedWrites||[]).length;report.pageErrors=errors;assert.deepEqual(errors,[]);
   await page.screenshot({path:path.join(output,'confirmation-snapshot-native.png')});
   report.passed=true;
 }catch(error){report.failure=error.message;throw error;}finally{
   report.transport=await page.evaluate(()=>acceptanceTransport).catch(()=>[]);
   releaseHold();await context.setOffline(false);await context.close();await browser.close();
   for(const socket of tunnels)socket.destroy();await new Promise(resolve=>proxy.close(resolve));
   const serialized=JSON.stringify(report,null,2)+'\n';
   fs.writeFileSync(path.join(output,'confirmation-snapshot-browser.json'),serialized);
   fs.writeFileSync(path.join(output,'confirmation-snapshot-browser-'+Date.now()+'.json'),serialized);
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
