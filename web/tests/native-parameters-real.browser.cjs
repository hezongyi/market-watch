// Actual desktop configuration and licensed native chart. Own workspaces only.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],checks=[],writes=[],owned=new Set();let ticker=null;
 const chartResponses=[],historyQueries=new Map();
 page.on('response',async r=>{
  if(r.url().endsWith('/api/charts/history-loads')&&r.request().method()==='POST'){
   const query=r.request().postDataJSON()?.query,data=await r.json().catch(()=>({}));
   if(query?.instrument?.startsWith('NATIVE:')){
    if(data.load?.id)historyQueries.set(data.load.id,query);
    if(data.result)chartResponses.push({status:r.status(),query,data:data.result});
   }
  }else if(/\/api\/charts\/history-loads\/[^/]+\/result$/.test(r.url())){
   const id=r.url().split('/').at(-2),data=await r.json().catch(()=>({})),query=historyQueries.get(id);
   if(query&&data.result)chartResponses.push({status:r.status(),query,data:data.result});
  }
 });
 page.on('response',async r=>{if(r.url().endsWith('/api/charts/data')&&r.request().method()==='POST'){
  const body=r.request().postDataJSON();if(body?.instrument?.startsWith('NATIVE:')){
   const data=await r.json().catch(()=>({}));chartResponses.push({status:r.status(),query:body,data});
  }
 }});
 const report={environment:'Ubuntu isolated market-watch-three-layer',base,passed:false,checks,errors};
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname)});
 page.on('response',async r=>{if(r.url().endsWith('/api/advanced-charts/workspaces')&&r.request().method()==='POST'&&r.ok())owned.add((await r.json()).id)});
 const get=async p=>{const r=await page.request.get(base+'/api/'+p);expect(r.ok()).toBe(true);return r.json()};
 const post=async(p,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+p,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBe(true);return r.json()};
 try{
  await expect.poll(async()=>{try{return(await page.request.get(base+'/readyz')).status()}catch{return 0}},{timeout:90000}).toBe(200);
  await page.goto(base+'/market-data?tab=platform&source=oanda&query=EUR_USD');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await page.getByRole('link',{name:'配置原生参数',exact:true}).click();
  await expect(page.getByRole('heading',{name:'配置原生行情'})).toBeVisible();
  await expect(page.getByLabel('价格口径',{exact:true})).toBeEnabled();
  expect(await page.getByLabel('价格口径',{exact:true}).inputValue()).toBe('B');
  expect(await page.getByLabel('日对齐小时',{exact:true}).inputValue()).toBe('17');
  for(const width of [1024,1440,1920]){
   await page.setViewportSize({width,height:1000});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
  }
  await page.setViewportSize({width:1024,height:1000});
  await page.locator('.data-center').evaluate(e=>e.style.zoom='2');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
  await page.getByLabel('价格口径',{exact:true}).focus();await page.keyboard.press('Tab');
  await expect(page.getByLabel('开盘价',{exact:true})).toBeFocused();
  await page.screenshot({path:path.join(artifacts,'native-parameters-zoom.png'),fullPage:true});
  await page.locator('.data-center').evaluate(e=>e.style.zoom='');
  checks.push('desktop 1024/1440/1920, keyboard order and 200 percent content zoom');
  await page.getByLabel('价格口径',{exact:true}).selectOption('M');
  await page.getByLabel('开盘价',{exact:true}).selectOption('true');
  await page.getByLabel('日对齐小时',{exact:true}).fill('0');
  await page.getByLabel('对齐时区',{exact:true}).fill('invalid/timezone');
  await page.getByLabel('周对齐',{exact:true}).selectOption('Monday');
  await page.getByRole('button',{name:'保存原生配置',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('IANA');
  await expect(page.getByLabel('价格口径',{exact:true})).toHaveValue('M');
  await expect(page.getByLabel('开盘价',{exact:true})).toHaveValue('true');
  await page.getByLabel('对齐时区',{exact:true}).fill('UTC');
  await page.getByRole('button',{name:'保存原生配置',exact:true}).click();
  await expect(page.getByRole('link',{name:'打开配置图表',exact:true})).toBeVisible();
  ticker=new URL(base+await page.getByRole('link',{name:'打开配置图表',exact:true}).getAttribute('href')).searchParams.get('platform');
  expect(ticker).toMatch(/^MWP:NATIVE:[a-f0-9]{32}$/);
  await expect(page.getByRole('status')).toContainText('mid · 平滑 · UTC 00:00 · Monday');
  expect(writes.some(p=>/composites\/use|market-data\/activity|provider\/subscribe|\/datasets$/.test(p))).toBe(false);
  checks.push('invalid timezone keeps fields; saved fixed Mid smooth UTC0 Monday identity; configuration creates no collection demand');
  await page.getByRole('link',{name:'打开配置图表',exact:true}).click();
  const frame=()=>page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
  await expect.poll(async()=>{const f=frame();return f?f.evaluate(()=>typeof widget!=='undefined'&&typeof ready!=='undefined'&&ready).catch(()=>false):false},{timeout:90000}).toBe(true);
  let f=frame();
  expect(await f.evaluate(()=>MWSeries.decode(widget.activeChart().symbol()).symbol)).toBe(ticker.slice(4));
  for(const resolution of ['240','1D','1M']){
   await f.evaluate(async r=>{await widget.activeChart().setResolution(r,{doNotActivateChart:true})},resolution);
   await f.waitForFunction(()=>!MWNativeNavigation.busy(),null,{timeout:120000});
   await expect.poll(()=>f.evaluate(r=>[...lastHistory.entries()].some(([key,value])=>key.split('|')[1]===r&&Number.isFinite(value)),resolution),{timeout:120000}).toBe(true);
   const observed=await f.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),
    presentations:[...symbolPresentations.entries()],histories:[...lastHistory.entries()].map(([k,v])=>({key:k,last_time:v}))}));
   expect(observed.symbol.toUpperCase()).toBe(ticker.toUpperCase());expect(observed.resolution).toBe(resolution);
   expect(observed.presentations.find(([key])=>key===ticker.slice(4))[1].native_parameters).toEqual({price:'M',smooth:true,dailyAlignment:0,alignmentTimezone:'UTC',weeklyAlignment:'Monday'});
   const timeframe={'240':'H4','1D':'D1','1M':'MN'}[resolution];
   await expect.poll(()=>chartResponses.some(r=>r.status===200&&r.query.timeframe===timeframe&&r.data.bars?.length>0),{timeout:60000}).toBe(true);
   const actual=chartResponses.filter(r=>r.status===200&&r.query.timeframe===timeframe&&r.data.bars?.length>0).at(-1);
   expect(actual.data.basis).toBe('mid');expect(actual.data.native_parameters).toEqual({price:'M',smooth:true,dailyAlignment:0,alignmentTimezone:'UTC',weeklyAlignment:'Monday'});
   observed.visible_input={dataset_id:actual.data.dataset_id,bars:actual.data.bars.slice(-5)};
   (report.charts||=[]).push(observed);
   await page.screenshot({path:path.join(artifacts,`native-parameters-chart-${resolution}.png`),fullPage:true});
  }
  checks.push('actual licensed H4 D1 MN chart resolves exact configured supplier identity');
  await page.reload();
  await expect.poll(async()=>{const current=frame();return current?current.evaluate(()=>typeof widget!=='undefined'&&typeof ready!=='undefined'&&ready).catch(()=>false):false},{timeout:90000}).toBe(true);
  f=frame();expect(await f.evaluate(()=>MWSeries.decode(widget.activeChart().symbol()).symbol)).toBe(ticker.slice(4));
  checks.push('workspace reload preserves configured ticker');
  expect(errors).toEqual([]);report.passed=true;
 }catch(e){report.failure=String(e);const f=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
  if(f)report.diagnostics=await f.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),
   histories:[...lastHistory.entries()],navigation:MWNativeNavigation.diagnostics()})).catch(e=>({error:String(e)}));
  report.responses=chartResponses;await page.screenshot({path:path.join(artifacts,'native-parameters-browser-failure.png'),fullPage:true});throw e}
 finally{
  await page.goto(base+'/market-data?tab=platform&source=oanda');
  for(const id of owned){const row=(await get('advanced-charts/workspaces')).find(x=>x.id===id);if(row)await post('advanced-charts/workspaces/'+id+'/delete',{revision:row.revision})}
  fs.writeFileSync(path.join(artifacts,'native-parameters-browser.json'),JSON.stringify(report,null,2)+'\n');await browser.close();
 }
 console.log(JSON.stringify({passed:report.passed,checks}));
})().catch(e=>{console.error(e);process.exit(1)});
