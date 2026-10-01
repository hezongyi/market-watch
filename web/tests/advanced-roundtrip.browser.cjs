const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454',SYMBOL='OANDA:EUR_CHF';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 async function getFrame(target=page){
  await target.frameLocator('iframe').locator('#chart').waitFor();
  const f=target.frames().find(f=>f.url().startsWith(CHART+'/'));
  await f.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});return f;
 }
 async function save(f){await f.waitForFunction(()=>!loading&&!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:30000});await f.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,error=>reject(Error(JSON.stringify(error))))));}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const first=await api('advanced-charts/workspaces',{name:'画线保存兼容验收 A'});
  await page.goto(APP+'/advanced-charts');let f=await getFrame();
  await f.evaluate(async symbol=>{const c=widget.activeChart();await c.setResolution('5',{doNotActivateChart:true});await c.setSymbol(symbol,{doNotActivateChart:true});},SYMBOL);
  await f.waitForFunction(()=>widget.activeChart().dataReady());
  const shape=await f.evaluate(()=>widget.activeChart().createShape({price:0.938,time:widget.activeChart().getVisibleRange().to},{shape:'horizontal_line'}));
  await f.evaluate(()=>widget.activeChart().setResolution('1',{doNotActivateChart:true}));
  await f.waitForFunction(()=>widget.activeChart().dataReady());
  assert.ok((await f.evaluate(()=>widget.activeChart().getAllShapes())).some(s=>s.id===shape),'same-series drawing shared across periods');
  await save(f);const firstMeta=(await api('advanced-charts/native-charts')).find(x=>x.id===first.id);
  const second=await api('advanced-charts/workspaces',{name:'画线保存兼容验收 B'});
  await page.goto(APP+'/advanced-charts');f=await getFrame();
  await f.evaluate(async symbol=>{const c=widget.activeChart();await c.setResolution('1',{doNotActivateChart:true});await c.setSymbol(symbol,{doNotActivateChart:true});},SYMBOL);
  await f.waitForFunction(()=>widget.activeChart().dataReady());
  assert.equal((await f.evaluate(()=>widget.activeChart().getAllShapes())).length,0,'different workspace never inherits drawings');
  await save(f);
  await f.evaluate(meta=>widget.loadChartFromServer(meta),firstMeta);
  await f.waitForFunction(symbol=>!loading&&widget.activeChart().symbol()===symbol&&widget.activeChart().dataReady(),SYMBOL,{timeout:60000});
  assert.ok((await f.evaluate(()=>widget.activeChart().getAllShapes())).some(s=>s.id===shape),'save/reopen retains original drawing');
  assert.equal(await f.evaluate(()=>widget.activeChart().resolution()),'1');
  await save(f);const beforeMobile=await api('advanced-charts/native-charts/'+first.id);
  const mobile=await browser.newContext({ignoreHTTPSErrors:true,isMobile:true,hasTouch:true,viewport:{width:390,height:844},storageState:await page.context().storageState()});
  const phone=await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));
  await phone.goto(APP+'/advanced-charts');const mf=await getFrame(phone);
  assert.equal(await mf.evaluate(()=>widget.chartsCount()),1);assert.equal(await mf.evaluate(()=>widget.activeChart().symbol()),SYMBOL);
  await mf.evaluate(()=>widget.activeChart().setSymbol('MWP:XAUUSD',{doNotActivateChart:true}));
  await mf.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
  await phone.waitForTimeout(4000);
  const afterMobile=await api('advanced-charts/native-charts/'+first.id);
  assert.deepEqual(afterMobile.document,beforeMobile.document,'mobile temporary changes never save desktop workspace');
  assert.equal(afterMobile.revision,beforeMobile.revision);
  await mobile.close();assert.deepEqual(errors,[]);
  const evidence={passed:true,workspaces:[first.id,second.id],shape,managed_symbol:SYMBOL,mobile_readonly:true,errors};
  fs.writeFileSync('/tmp/mw-roundtrip-container.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 }catch(error){await page.screenshot({path:'/tmp/mw-roundtrip-failure.png',fullPage:true}).catch(()=>{});throw error;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
