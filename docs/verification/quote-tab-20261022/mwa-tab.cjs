const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium, expect} = require(process.cwd()+'/web/node_modules/@playwright/test');
const base='https://192.168.7.232:18280', origin='https://192.168.7.232:18281';
const workspace='7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
(async()=>{
 const browser=await chromium.launch();
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 const page=await context.newPage();
 const report={checks:[],errors:[],messages:[],blockedWrites:[]};
 page.on('pageerror',e=>report.errors.push(e.message));
 await context.route('**/api/advanced-charts/**',async route=>{
   if(['GET','HEAD','OPTIONS'].includes(route.request().method()))return route.continue();
   report.blockedWrites.push({path:new URL(route.request().url()).pathname,method:route.request().method()});
   if(route.request().url().endsWith('/preferences/migrate'))return route.fulfill({json:{ok:true}});
   if(route.request().url().endsWith('/preferences/save')){
    const body=route.request().postDataJSON();
    return route.fulfill({json:{...body,id:'inspection-only',revision:body.revision+1,updated_at:Date.now()}});
   }
   return route.fulfill({status:409,json:{detail:'Read-only title inspection'}});
 });
 await page.addInitScript(()=>{window.tabMessages=[];window.addEventListener('message',e=>{if(e.data?.type==='active-quote')window.tabMessages.push(e.data);});});
 try{
  await page.goto(base+'/advanced-charts/'+workspace);
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('/home/quant/repos/.mwa-composite-mapping-20261021/browser-login.json')).password);
  await page.locator('button.auth-submit').click();
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith(origin+'/')),{timeout:60000}).toBe(true);
  const host=page.frames().find(f=>f.url().startsWith(origin+'/'));
  await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  const get=async path=>{const r=await context.request.get(base+'/api'+path);assert.equal(r.status(),200);return r.json();};
  const before=await get('/advanced-charts/workspaces/'+workspace);
  const preferences=await get('/advanced-charts/preferences');
  for(const ticker of ['MWP:EURUSD','MWC:8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb','MWH:63bc01d4-3943-45cc-93a5-b04c3caaab16']){
   await host.evaluate(t=>{widget.activeChart().setSymbol(t);},ticker);
   await expect.poll(()=>host.evaluate(t=>widget.activeChart().symbol().toLowerCase()===t.toLowerCase()&&widget.activeChart().dataReady(),ticker),{timeout:60000}).toBe(true);
   await expect.poll(()=>page.evaluate(t=>window.tabMessages.some(m=>m.ticker.toLowerCase()===t.toLowerCase()&&Number.isFinite(m.price)),ticker),{timeout:45000}).toBe(true);
   await page.waitForTimeout(1500);
   const state=await host.evaluate(()=>({symbol:widget.activeChart().symbol(),rows:[...quoteSnapshotRows.values()].filter(r=>r.n.startsWith('MWC:')||r.n.startsWith('MWH:')).map(r=>({n:r.n,s:r.s,lp:r.v.lp,ch:r.v.ch,chp:r.v.chp}))}));
   const title=await page.title();
   report.checks.push({ticker,title,...state});
   console.log(JSON.stringify(report.checks.at(-1)));
   if(!process.env.OBSERVE_ONLY){
    if(ticker.startsWith('MWH:'))assert.equal(title,`EURUSD·历史 [${before.name.trim()}]`);
    else assert.match(title,/[▲▼] [＋+−-]\d+\.\d{2}%/);
   }
  }
  await page.reload();
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith(origin+'/')),{timeout:60000}).toBe(true);
  const reloaded=page.frames().find(f=>f.url().startsWith(origin+'/'));
  await reloaded.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  await reloaded.evaluate(()=>{widget.activeChart().setSymbol('MWH:63bc01d4-3943-45cc-93a5-b04c3caaab16');});
  if(!process.env.OBSERVE_ONLY)await expect(page).toHaveTitle(`EURUSD·历史 [${before.name.trim()}]`,{timeout:30000});
  report.refreshPassed=true;
  assert.deepEqual(await get('/advanced-charts/workspaces/'+workspace),before);
  report.workspaceUnchanged=true;
  // Other open user sessions may legitimately update global preferences.
  report.preferencesUnchanged=JSON.stringify(await get('/advanced-charts/preferences'))===JSON.stringify(preferences);
  assert.ok(await page.locator('link[rel="icon"]').count());
  assert.deepEqual(report.errors,[]);
  report.passed=true;
 }catch(e){report.failure=e.message;process.exitCode=1;}
 finally{
  report.messages=await page.evaluate(()=>window.tabMessages).catch(()=>[]);
  fs.mkdirSync('artifacts/quote-tab-20261022',{recursive:true});
  fs.writeFileSync('artifacts/quote-tab-20261022/'+(process.env.OBSERVE_ONLY?'before':'after')+'.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,failure:report.failure,errors:report.errors,refreshPassed:report.refreshPassed,workspaceUnchanged:report.workspaceUnchanged,preferencesUnchanged:report.preferencesUnchanged}));
  await browser.close();
 }
})();
