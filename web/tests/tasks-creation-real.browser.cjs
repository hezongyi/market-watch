// Actual Ubuntu API/PG. History worker must be stopped before this owned
// registration check, and restarted after cleanup. No supplier data is faked.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration');
const base='http://127.0.0.1:16629';

(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const page=await context.newPage(),events=[],errors=[];
 const report={environment:'Ubuntu isolated market-watch-three-layer',passed:false,checks:[],errors};
 let owned=null,task=null;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('/api/market-data/center/creations/')||
  (r.url().endsWith('/api/market-data/center/datasets')&&r.method()==='POST'))events.push({method:r.method(),path:new URL(r.url()).pathname})});
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok()).toBe(true);return r.json()};
 const post=async(route,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+route,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBe(true);return r.json()};
 try{
  await page.goto(base+'/market-data');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('heading',{name:'数据中心',exact:true})).toBeVisible();
  const existing=await get('market-data/datasets');
  const code=['EUR/GBP','AUD/CAD','NZD/JPY'].find(symbol=>!existing.some(d=>d.identity.source==='dukascopy'&&
    d.identity.provider_symbol===symbol&&d.identity.calendar_version==='user-other-utc0-v1'));
  expect(code,'Requires a new, explicitly owned semantic identity; never overwrite existing maintenance').toBeTruthy();
  const logical=code.replace('/','');
  const baseline=await get('market-data/center/tasks?status=active&page_size=100');
  expect(baseline.total,'Pause the history worker only when there is no active supplier work').toBe(0);
  await page.goto(base+'/market-data/datasets/new');
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  const summary=page.getByRole('alert');await expect(summary).toBeFocused();
  await expect(summary.getByRole('link')).toHaveCount(3);
  await summary.getByRole('link',{name:/填写1–10/}).click();await expect(page.locator('#create-logical')).toBeFocused();
  await page.locator('#create-logical').fill(logical);await page.locator('#create-symbol').fill(code);
  await page.getByLabel('资产类别').selectOption('other');await page.locator('#create-precision').fill('5');
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await expect(summary).toBeFocused();await expect(summary.getByRole('link')).toHaveCount(2);
  await summary.getByRole('link',{name:'明确选择聚合日界。'}).click();await expect(page.locator('#create-calendar')).toBeFocused();
  await page.locator('#create-calendar').selectOption('utc0');
  await page.locator('#create-day').fill(new Date().toISOString().slice(0,10));
  await page.getByLabel('维护计划').selectOption('once');
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await expect(page.getByRole('heading',{name:new RegExp(logical)})).toBeVisible();
  report.checks.push('multiple field errors retain input, focus linked summary and expand precision field; index/other require explicit calendar');
  let submissions=0,lookupFailures=0;
  await page.route('**/api/market-data/center/datasets',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   submissions++;const response=await route.fetch();expect(response.status()).toBe(201);
   const result=await response.json();owned=result.dataset.id;task=result.task.id;
   fs.writeFileSync(path.join(artifacts,'tasks-creation-owned.json'),JSON.stringify({dataset_id:owned,task_id:task,logical_symbol:logical,provider_symbol:code},null,2));
   await route.abort('failed'); // Successful commit with lost browser response.
  });
  await page.route('**/api/market-data/center/creations/*',async route=>{
   lookupFailures++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'controlled lookup unavailable'})});
  });
  await page.getByRole('button',{name:'创建并开始维护',exact:true}).click();
  await expect(summary).toContainText('创建结果暂无法核实');await expect(summary).toBeFocused();
  await expect(page.getByRole('button',{name:'上一步',exact:true})).toBeDisabled();
  expect(submissions).toBe(1);expect(lookupFailures).toBe(1);
  await page.unroute('**/api/market-data/center/creations/*');
  await page.getByRole('button',{name:'核查创建结果并重试',exact:true}).click();
  await expect(page).toHaveURL(base+'/market-data/datasets/'+owned);
  expect(submissions).toBe(1);expect(events.map(e=>e.method)).toEqual(['POST','GET','GET']);
  report.checks.push('real creation committed once; lost201 plus controlled lookup503 pins submit body; next action GET finds same task without duplicate POST');
  await page.unroute('**/api/market-data/center/datasets');
  await page.getByRole('link',{name:'查看维护任务',exact:true}).click();
  await expect(page.getByRole('button',{name:'运行及需处理',exact:true})).toHaveAttribute('aria-pressed','true');
  const row=page.locator('.dc-table tbody tr');await expect(row).toHaveCount(1);
  await expect(row).toContainText(logical);await expect(row).toContainText('更新历史');
  await expect(row).toContainText('排队中');await expect(row).toContainText('创建：');
  await page.getByRole('button',{name:'暂停任务',exact:true}).click();await expect(row).toHaveCount(0);
  await page.getByRole('button',{name:'已暂停',exact:true}).click();await expect(row).toHaveCount(1);
  const paused=(await get(`market-data/center/tasks?dataset_id=${owned}&status=paused`)).items[0];
  expect(paused.id).toBe(task);expect(paused.updated_at).toBeGreaterThanOrEqual(paused.created_at);
  expect(paused.started_at).toBeNull();expect(paused.cursor).toBe(paused.start);
  await page.getByRole('button',{name:'取消任务',exact:true}).click();await expect(row).toHaveCount(0);
  await page.getByRole('button',{name:'历史记录',exact:true}).click();await expect(row).toHaveCount(1);
  await expect(row).toContainText('已取消');
  await page.getByLabel('搜索品种').fill('%');await expect(row).toHaveCount(0);
  await page.getByLabel('搜索品种').fill(logical);await expect(row).toHaveCount(1);
  for(const width of [1024,1440,1920]){
   await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
  }
  await page.locator('.data-center').evaluate(el=>el.style.zoom='2');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
  await page.locator('.data-center').evaluate(el=>el.style.zoom='');
  report.checks.push('actual pending→paused→cancelled task: server filters, created/mutation times, literal search, three widths and200% content zoom; no supplier read');
  await page.goto(base+'/market-data?tab=tasks&status=history&query=EURUSD');
  const history=await get('market-data/center/tasks?status=history&query=EURUSD&page_size=25');
  expect(history.total).toBeGreaterThan(0);await expect(page.locator('.dc-table tbody tr')).toHaveCount(history.items.length);
  const reads=await get(`market-data/versions/${task}/requests`);expect(reads.total).toBe(0);
  await post(`market-data/datasets/${owned}/maintenance/control`,{action:'pause'});
  await post(`market-data/datasets/${owned}/maintenance/control`,{action:'archive'});
  const detail=await get(`market-data/center/datasets/${owned}`);
  expect(detail.maintenance.paused&&detail.maintenance.archived).toBe(true);
  expect(detail.usable_timeframes).toEqual([]);
  report.owned={dataset_id:owned,task_id:task,state:'cancelled task; paused/archived once plan; zero reads; registration journal retained'};
  await page.screenshot({path:path.join(artifacts,'tasks-creation-real-browser.png'),fullPage:true});
  expect(errors).toEqual([]);report.passed=true;
 }catch(e){report.failure=String(e);throw e}
 finally{
  if(owned){ // Only this new identity; preserve all existing datasets/configuration.
   try{const detail=await get(`market-data/center/datasets/${owned}`);
    if(detail.maintenance.active_version_id)await post(`market-data/tasks/${task}/control`,{action:'cancel'});
    await post(`market-data/datasets/${owned}/maintenance/control`,{action:'pause'});
    await post(`market-data/datasets/${owned}/maintenance/control`,{action:'archive'});
   }catch(e){report.cleanupFailure=String(e);report.passed=false;process.exitCode=1}
  }
  fs.writeFileSync(path.join(artifacts,'tasks-creation-real-browser.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();
 }
 console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
})().catch(e=>{console.error(e);process.exitCode=1});
