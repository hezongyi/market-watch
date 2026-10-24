// Native acceptance runner. Run only after the user authorizes acceptance.
// Faults and saves are scoped to this disposable browser context; never seed,
// delete snapshots, mark messages read, or change the protected browser profile.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
for(const name of ['MW_TEST_BASE_URL','MW_TEST_CHART_URL','MW_TEST_CREDENTIALS_FILE','MW_TEST_ARTIFACT_DIR'])
 if(!process.env[name])throw Error(name+' is required');
const base=new URL(process.env.MW_TEST_BASE_URL).origin,chartOrigin=new URL(process.env.MW_TEST_CHART_URL).origin;
const credentials=JSON.parse(fs.readFileSync(process.env.MW_TEST_CREDENTIALS_FILE));
const output=path.resolve(process.env.MW_TEST_ARTIFACT_DIR);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report={base,chartOrigin,boundary:'real application, PG and native charts; browser-only fault injection; no persistent settings/notification writes',cases:[],passed:false};
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:1000}});
 let preferences,holdInstrument=null,releaseHold,held=false,compareMismatch=false,targetInstrument;
 const gate=new Promise(resolve=>releaseHold=resolve),writes=[];
 await context.addInitScript(()=>{
   globalThis.acceptanceStates=[];globalThis.acceptanceTransport=[];
   addEventListener('message',({data:m})=>{if(m?.channel==='mw-chart-v1' && m.type==='chart-indicator-state')
     acceptanceStates.push({index:m.index,id:m.id,state:m.state,epoch:m.epoch});});
   const Native=EventSource;
   globalThis.EventSource=class extends Native{
     constructor(...args){super(...args);for(const event of ['open','error'])this.addEventListener(event,()=>{
       acceptanceTransport.push({event,readyState:this.readyState,at:Date.now()});
     });}
   };
 });
 // Shadow preferences are read/write consistent. Fake successful writes must
 // never be paired with subsequent reads of stale real settings.
 await context.route('**/api/advanced-charts/**',async route=>{
   const request=route.request(),url=new URL(request.url()),read=['GET','HEAD','OPTIONS'].includes(request.method());
   if(url.pathname.endsWith('/preferences') && read){
     if(!preferences)preferences=await (await route.fetch()).json();
     return route.fulfill({json:preferences});
   }
   if(read)return route.continue();
   writes.push(url.pathname);
   if(url.pathname.endsWith('/preferences/migrate'))return route.fulfill({json:{ok:true}});
   if(url.pathname.endsWith('/preferences/save')){
     if(!preferences)throw Error('Preference save before shadow baseline');
     const body=request.postDataJSON(),old=preferences.find(p=>p.kind===body.kind&&p.name===body.name&&p.tool===(body.tool||''));
     const row={...body,id:old?.id||hash([body.kind,body.name,body.tool||'']),revision:(old?.revision||0)+1,updated_at:Date.now()};
     preferences=preferences.filter(p=>p.id!==row.id);preferences.push(row);return route.fulfill({json:row});
   }
   return route.fulfill({status:409,json:{detail:'验收浏览器未保存此操作'}});
 });
 await context.route('**/api/notification-center/**',route=>{
   if(['GET','HEAD','OPTIONS'].includes(route.request().method()))return route.continue();
   writes.push(new URL(route.request().url()).pathname);
   return route.fulfill({json:{ok:true}});
 });
 await context.route('**/api/charts/data',async route=>{
   const q=route.request().postDataJSON();
   if(q.instrument===holdInstrument&&!q.indicators?.length){held=true;await gate;}
   if(compareMismatch&&q.instrument===targetInstrument&&!q.indicators?.length){
     compareMismatch=false;
     const response=await route.fetch(),json=await response.json();
     assert(Number.isSafeInteger(json.cache_revision));
     json.cache_revision++;
     return route.fulfill({response,json});
   }
   return route.continue();
 });
 const page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
   await page.goto(base+'/advanced-charts/mw75-real');
   await page.getByLabel('管理员密码').fill(credentials.login_password);
   await page.locator('button.auth-submit').click();
   await expect.poll(()=>page.frames().some(f=>f.url().startsWith(chartOrigin+'/?')),{timeout:90000}).toBe(true);
   const host=page.frames().find(f=>f.url().startsWith(chartOrigin+'/?'));
   await host.waitForFunction(()=>typeof widget!=='undefined'&&ready&&!loading&&widget.chartsCount()>1&&widget.activeChart().dataReady(),null,{timeout:120000});
   assert.equal(await host.evaluate(()=>typeof resumeDeferredDisplayRecoveries),'function','deploy the approved candidate before running acceptance');
   const index=await host.evaluate(()=>widget.chartsCount()-1);
   await host.evaluate(async({index,symbol})=>{
     const c=widget.chart(index);await new Promise(resolve=>c.setSymbol(symbol,resolve));
     await new Promise(resolve=>c.setResolution('1D',resolve));
     for(const name of ['SWING_SR_V1','SUPERTREND_PINE_V1','RSI'])await c.createStudy('守望 Python '+name,false,false);
   },{index,symbol:process.env.MW_TEST_PROVIDER_SYMBOL||'MWP:XAUUSD'});
   await host.waitForFunction(index=>widget.chart(index).dataReady()&&widget.chart(index).getAllStudies().length>=3,index,{timeout:120000});
   targetInstrument=await host.evaluate(index=>decode(widget.chart(index).symbol()).symbol,index);
   const settings=()=>host.evaluate(index=>{const c=widget.chart(index);return {
     studies:c.getAllStudies().map(({id})=>({id,inputs:c.getStudyById(id).getInputValues(),styles:c.getStudyById(id).getStyleValues()})),
     range:c.getVisibleRange(),origin:indicatorBindings.get(indicatorKey(c.symbol(),c.resolution()))?.calculationStart};},index);
   const before=await settings();
   holdInstrument=await host.evaluate(()=>decode(widget.chart(0).symbol()).symbol);
   assert.notEqual(holdInstrument,targetInstrument,'choose two distinct price series for the busy test');
   await host.evaluate(()=>{globalThis.acceptanceOther=reloadHistory(widget.chart(0).symbol(),widget.chart(0).resolution());});
   await expect.poll(()=>held,{timeout:20000}).toBe(true);
   compareMismatch=true;
   await host.evaluate(index=>{
     const c=widget.chart(index),key=indicatorKey(c.symbol(),c.resolution()),token='0'.repeat(64);
     indicatorBindings.get(key).providerSnapshot=token;
     globalThis.acceptanceRecovery=recoverDisplaySnapshot(c.symbol(),c.resolution(),token,false,{reason:'missing'});
   },index);
   await host.waitForFunction(index=>displayRecoveries.get(indicatorKey(widget.chart(index).symbol(),'1D'))?.state==='deferred',index);
   await page.waitForTimeout(3500);
   const waiting=await host.evaluate(index=>{const e=displayRecoveries.get(indicatorKey(widget.chart(index).symbol(),'1D'));return {state:e.state,attempts:e.attempts};},index);
   assert.equal(waiting.state,'deferred');assert.equal(waiting.attempts,0);
   holdInstrument=null;releaseHold();
   await host.evaluate(async()=>{await acceptanceOther;await acceptanceRecovery;});
   await host.waitForFunction(index=>displayRecoveries.get(indicatorKey(widget.chart(index).symbol(),'1D'))?.state==='ready',index,{timeout:120000});
   await expect.poll(async()=>{const states=await page.evaluate(()=>acceptanceStates);return states.filter(s=>s.index===index&&s.state==='ready'&&!s.id.startsWith('display-snapshot:')).length;},{timeout:120000}).toBeGreaterThanOrEqual(3);
   const after=await settings();assert.equal(hash(after.studies),hash(before.studies));assert.equal(after.origin,before.origin);
   assert(Math.abs(after.range.from-before.range.from)<86400&&Math.abs(after.range.to-before.range.to)<86400);
   report.cases.push('real multi-chart reload held >3s; zero deferred failures; price and three dependent indicators restored with settings/origin/range retained');
   const count=await page.evaluate(()=>acceptanceTransport.length);
   await context.setOffline(true);
   await expect.poll(()=>page.evaluate(count=>acceptanceTransport.slice(count).some(e=>e.event==='error'),count),{timeout:30000}).toBe(true);
   await context.setOffline(false);
   await expect.poll(()=>page.evaluate(count=>acceptanceTransport.slice(count).some(e=>e.event==='open'),count),{timeout:45000}).toBe(true);
   report.cases.push('real browser SSE interruption and reopen; native retry semantics retained');
   report.transport=await page.evaluate(()=>acceptanceTransport.map(e=>({...e})));
   report.blockedWrites=writes.length;report.pageErrors=errors;assert.deepEqual(errors,[]);
   await page.screenshot({path:path.join(output,'confirmation-snapshot-native.png')});
   report.passed=true;
 }finally{
   releaseHold();await context.setOffline(false);await context.close();await browser.close();
   fs.writeFileSync(path.join(output,'confirmation-snapshot-browser.json'),JSON.stringify(report,null,2)+'\n');
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
