// Real ten-symbol persistent demand, two four-chart workspaces and maintenance.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),artifacts=path.join(root,'artifacts/data-integration');
const base='http://127.0.0.1:16629',setup=JSON.parse(fs.readFileSync(path.join(artifacts,'concurrency10-real-01.json')));
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),pages=[],owned=new Set();
 const report={environment:'Ubuntu market-watch-three-layer',passed:false,errors:[],checks:[],charts:[]};
 const login=JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json')));
 const page=await context.newPage();pages.push(page);
 const track=p=>{
  p.on('pageerror',e=>report.errors.push(e.message));
  p.on('response',async r=>{if(r.request().method()==='POST'&&r.url().endsWith('/api/advanced-charts/workspaces')&&r.ok())owned.add((await r.json()).id)});
 };track(page);
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok()).toBe(true);return r.json()};
 const post=async(route,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+route,{headers:{'X-CSRF-Token':csrf},data});expect(r.ok()).toBe(true);return r.json()};
 try{
  expect(setup.passed).toBe(true);expect(setup.records).toHaveLength(10);
  await page.goto(base+'/');await page.getByLabel('管理员密码').fill(login.password);await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('button',{name:'新建预警',exact:true})).toBeVisible({timeout:60000});
  const before=new Map((await get('watches')).filter(r=>setup.records.some(s=>s.watch_id===r.id)).map(r=>[r.id,r.market_identity]));
  const groups=[setup.records.slice(0,4),[setup.records[0],...setup.records.slice(4,7)]];
  for(let index=0;index<groups.length;index++){
   const p=index===0?page:await context.newPage();if(index){pages.push(p);track(p)}
   await p.goto(base+'/advanced-charts?platform=MWP:OANDA:EUR_USD');
   const frame=await expect.poll(()=>p.frames().some(f=>f.url().startsWith('http://127.0.0.1:16630/')),{timeout:60000}).toBe(true).then(()=>p.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/')));
   await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready,null,{timeout:120000});
   await frame.evaluate(()=>widget.setLayout('4'));
   await frame.waitForFunction(()=>widget.chartsCount()===4,null,{timeout:60000});
   for(let cell=0;cell<4;cell++){
    await frame.evaluate(async({cell,ident})=>{await widget.chart(cell).setSymbol('MWC:'+ident,{doNotActivateChart:true});await widget.chart(cell).setResolution('1')},{cell,ident:groups[index][cell].composite_id});
   }
   for(const row of groups[index]){
    await expect.poll(()=>frame.evaluate(ident=>[...lastHistory.entries()].some(([key,value])=>key.toUpperCase().includes(ident.toUpperCase())&&Number.isFinite(value)),row.composite_id),{timeout:120000}).toBe(true);
   }
   report.charts.push(await frame.evaluate(()=>({symbols:Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).symbol()),history:[...lastHistory.entries()]})));
   await p.screenshot({path:path.join(artifacts,'concurrency10-multichart-'+index+'.png'),fullPage:true});
  }
  report.checks.push('two actual licensed four-chart workspaces with fixed composite input and shared EURUSD');
  await new Promise(r=>setTimeout(r,15000));
  const current=await get('watches');
  for(const row of setup.records){const w=current.find(w=>w.id===row.watch_id);expect(w.market_identity).toEqual(before.get(w.id));expect(w.status).toBe('active')}
  report.checks.push('ten persistent strategies retain immutable bindings while eight chart cells collect');
  // Keep both real workspaces open during the independent bounded maintenance
  // measurement. The caller owns the interval, and no fake price is injected.
  fs.writeFileSync(path.join(artifacts,'concurrency10-browser-open.json'),JSON.stringify({at:Date.now(),workspaces:[...owned]},null,2)+'\n');
   // Explicit opt-in test duration; the running browser process is the live
   // evidence that these charts stay open, rather than a marker file alone.
  const holdUntil=Date.now()+330000;
  while(Date.now()<holdUntil)await new Promise(r=>setTimeout(r,Math.min(1000,holdUntil-Date.now())));
  const after=await get('watches');
  for(const row of setup.records){const w=after.find(w=>w.id===row.watch_id);expect(w.market_identity).toEqual(before.get(w.id));expect(w.status).toBe('active')}
  report.checks.push('all ten strategy bindings remain pinned after the multichart maintenance interval');
  expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.failure=String(e).replaceAll(login.password,'[REDACTED]');throw new Error(report.failure)}
 finally{
  for(const p of pages)await p.goto(base+'/market-data').catch(()=>{});
  for(const id of owned){const row=(await get('advanced-charts/workspaces')).find(r=>r.id===id);if(row)await post('advanced-charts/workspaces/'+id+'/delete',{revision:row.revision})}
  fs.writeFileSync(path.join(artifacts,'concurrency10-browser.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();
 }
 console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
})().catch(e=>{console.error(e);process.exitCode=1});
