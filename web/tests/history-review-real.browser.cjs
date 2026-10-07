// Actual bounded historical recheck; simulate only a lost HTTP response, not data.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage(),report={environment:'Ubuntu isolated market-watch-three-layer',passed:false,checks:[],errors:[]};
 page.on('pageerror',e=>report.errors.push(e.message));
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok(),await r.text()).toBe(true);return r.json()};
 try{
  await page.goto(base+'/market-data');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.getByRole('heading',{name:'数据中心',exact:true})).toBeVisible();
  const record=JSON.parse(fs.readFileSync(path.join(artifacts,'calendar-history-real-01.json'))).records.find(r=>r.source==='dukascopy'&&r.symbol==='EURUSD'&&r.window==='spring');expect(record).toBeTruthy();
  const parent=(await get('market-data/center/datasets/'+record.dataset_id)).latest_version_id;
  const original=await get('market-data/versions/'+parent);
  const maintenance=await get('market-data/datasets/'+record.dataset_id+'/maintenance');
  expect(maintenance.paused).toBe(true);expect(maintenance.frequency).toBe('once');
  const url=base+'/market-data/datasets/'+record.dataset_id;
  await page.goto(url+'?section=maintenance');await page.getByLabel('任务类型',{exact:true}).selectOption('recheck');
  await page.getByLabel('起始交易日期',{exact:true}).fill('2026-03-06');await page.getByLabel('结束交易日期（不包含）',{exact:true}).fill('2026-03-07');
  let captured=null,attempts=[];
  const pattern='**/api/market-data/datasets/'+record.dataset_id+'/tasks';
  await page.route(pattern,async route=>{
   attempts.push(route.request().postDataJSON());
   if(!captured){const response=await route.fetch();expect(response.status()).toBe(201);captured=await response.json();await route.abort('failed');}
   else await route.continue();
  });
  await page.getByRole('button',{name:'提交复查',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('起始交易日期',{exact:true})).toHaveValue('2026-03-06');await expect(page.getByLabel('任务类型',{exact:true})).toHaveValue('recheck');
  const response=page.waitForResponse(r=>r.url().endsWith('/tasks')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'提交复查',exact:true}).click();const retry=await response;expect(retry.status()).toBe(201);
  expect((await retry.json()).id).toBe(captured.id);expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
  await expect(page.getByRole('status')).toContainText('指定区间复查已提交');await page.unroute(pattern);
  const start=Date.now();let task;
  while(Date.now()-start<180000){task=await get('market-data/versions/'+captured.id);if(task.status==='published')break;await page.waitForTimeout(2000)}
  expect(task.status).toBe('published');expect(task.parent_version_id).toBe(parent);expect(task.end).toBe(original.end);expect(task.start).toBe(original.start);
  const artifactStart=Date.now();let periods;
  while(Date.now()-artifactStart<60000){periods=await get('market-data/versions/'+captured.id+'/artifacts');if(periods.some(p=>p.timeframe==='M1'&&p.status==='published'))break;await page.waitForTimeout(1000)}
  expect(periods.some(p=>p.timeframe==='M1'&&p.status==='published')).toBe(true);
  expect((await get('market-data/versions/'+parent)).manifest).toEqual(original.manifest);
  expect((await get('market-data/datasets/'+record.dataset_id+'/maintenance')).configuration_revision).toBe(maintenance.configuration_revision);
  report.checks.push('real recheck plus lost successful HTTP response: retry retains fields and exact request key, returns same task; published parent manifest and paused plan unchanged');
  const comparison=await get('market-data/versions/'+captured.id+'/comparison');expect(comparison.previous.id).toBe(parent);expect(comparison.current.id).toBe(captured.id);
  await page.goto(url+'?section=versions&version='+captured.id);const region=page.getByRole('region',{name:'固定历史发布差异'});
  await expect(region.getByRole('heading',{name:'与前版差异'})).toBeVisible();await expect(region).toContainText(parent);await expect(region).toContainText(captured.id);
  await expect(region).toContainText('不等于逐分钟价格修订数量');await expect(region.getByRole('link',{name:'用于回测'})).toHaveCount(2);
  for(const width of [1024,1440,1920]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true)}
  await page.setViewportSize({width:1024,height:1000});await page.locator('.data-center').evaluate(el=>el.style.zoom='2');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
  await page.locator('.data-center').evaluate(el=>el.style.zoom='');await page.screenshot({path:path.join(artifacts,'history-review-real.png'),fullPage:true});
  report.checks.push('real fixed-parent publication comparison, exact replay links, three desktop widths and 200% content zoom');
  expect(report.errors).toEqual([]);report.task_id=captured.id;report.parent_version_id=parent;report.comparison=comparison.differences;report.passed=true;
 }catch(e){report.failure=String(e);throw e}
 finally{fs.writeFileSync(path.join(artifacts,'history-review-real-browser.json'),JSON.stringify(report,null,2)+'\n');await browser.close()}
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,task_id:report.task_id}));
})().catch(e=>{console.error(e);process.exitCode=1});
