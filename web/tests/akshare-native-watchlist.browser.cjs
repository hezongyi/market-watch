// Real native alias persistence; only a newly created acceptance list is removed.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const assert=require('node:assert/strict');
const {chromium,expect}=require('@playwright/test');
const config=JSON.parse(fs.readFileSync(process.env.MW_ACCEPTANCE_CREDENTIALS_FILE));
const output=process.env.MW_OUTPUT,base=process.env.MW_BASE_URL;
assert(output && base && process.env.MW_WORKSPACE_ID);
fs.mkdirSync(output,{recursive:true});
const cert=new crypto.X509Certificate(fs.readFileSync(config.tls_cert_file || config.ca_file));
const spki=crypto.createHash('sha256').update(cert.publicKey.export({format:'der',type:'spki'})).digest('base64');
const tickers=['MWP:SINA-NATIVE:SZSE:000001','MWP:TENCENT-NATIVE:SZSE:000001','MWP:TENCENT-NATIVE:HKEX:02318'];
const report={passed:false,errors:[]};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
   args:['--no-sandbox','--ignore-certificate-errors-spki-list='+spki]});
 const context=await browser.newContext({viewport:{width:1600,height:1000}});
 await context.addInitScript(()=>document.addEventListener('load',e=>{
  if(!e.target?.src?.endsWith('/charting_library.js') || !window.TradingView?.widget)return;
  const ctor=TradingView.widget;TradingView.widget=new Proxy(ctor,{construct(target,args,newTarget){
   const result=Reflect.construct(target,args,newTarget);window.__watchlistAcceptance=result;return result;
  }});
 },true));
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 let created,original;
 try {
  await page.goto(base+'/login');
  await page.evaluate(async password=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(!r.ok)throw Error('login failed');},config.login_password);
  await page.goto(base+'/advanced-charts/'+process.env.MW_WORKSPACE_ID+'?data_center='+encodeURIComponent('/market-data?tab=platform&source=akshare&query=02318'));
  const ready=async()=>{
   await page.waitForFunction(()=>!!window.__watchlistAcceptance,{}, {timeout:90000});
   await expect.poll(()=>page.evaluate(async()=>{
    try{return !!(await window.__watchlistAcceptance.watchList()).getAllLists();}catch{return false;}
   }),{timeout:90000}).toBe(true);
  };
  report.stage='initial ready';
  await ready();
  const frame=page.frames().find(frame=>frame.url().startsWith('blob:'));
  await expect(frame.locator('.dc-window')).toBeVisible({timeout:90000});
  await frame.getByRole('button',{name:'关闭数据中心',exact:true}).click();
  original=await page.evaluate(async()=>{const api=await window.__watchlistAcceptance.watchList();return {active:api.getActiveListId(),lists:api.getAllLists()};});
  created=await page.evaluate(async tickers=>{const api=await window.__watchlistAcceptance.watchList();const row=api.createList('原生周期自选验收',tickers);if(!row)throw Error('create list failed');api.setActiveList(row.id);return row.id;},tickers);
  await expect(async()=>{
   const saved=await page.evaluate(async()=>{const r=await fetch('/api/advanced-charts/preferences?kind=setting');if(!r.ok)throw Error('read preferences');return r.json();});
   const value=saved.find(row=>row.name==='mw.watchlists.v1')?.content.value;
   assert.equal(value?.active,created,'active watchlist must reach persistent preferences');
   assert.deepEqual(value.lists.find(row=>row.id===created)?.symbols,tickers);
  }).toPass({timeout:15000,intervals:[250,500]});
  report.stage='reload';await page.reload();await ready();
  await expect.poll(()=>page.evaluate(async()=> (await window.__watchlistAcceptance.watchList()).getActiveListId()),{timeout:15000}).toBe(created);
  const restored=await page.evaluate(async id=>{const api=await window.__watchlistAcceptance.watchList();return {active:api.getActiveListId(),symbols:api.getList(id)};},created);
  assert.equal(restored.active,created);assert.deepEqual(restored.symbols,tickers);
  report.restored=restored;
  await page.screenshot({path:path.join(output,'watchlist-restored.png')});
  await page.evaluate(async ({created,active})=>{const api=await window.__watchlistAcceptance.watchList();if(active)api.setActiveList(active);api.deleteList(created);},{created,active:original.active});
  await expect(async()=>{
   const state=await page.evaluate(async()=>{const api=await window.__watchlistAcceptance.watchList();return {active:api.getActiveListId(),lists:api.getAllLists()};});
   assert.deepEqual(state,original);
  }).toPass({timeout:10000});
  report.original_lists_preserved=true;
  assert.deepEqual(report.errors,[]);report.passed=true;
 } catch(error){report.errors.push(error.message);await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}
 finally {
  if(created && original)await page.evaluate(async ({created,active})=>{const api=await window.__watchlistAcceptance.watchList();if(active)api.setActiveList(active);if(api.getAllLists()?.[created])api.deleteList(created);},{created,active:original.active}).catch(()=>{});
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await context.close();await browser.close();console.log(JSON.stringify(report));
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
