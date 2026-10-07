// Two real editors on a dedicated acceptance plan; restore prior config in finally.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage(),peer=await context.newPage();
 const report={environment:'Ubuntu market-watch-three-layer',passed:false,checks:[],errors:[]};
 for(const p of [page,peer])p.on('pageerror',e=>report.errors.push(e.message));
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok()).toBe(true);return r.json()};
 const post=async(route,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+route,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBe(true);return r.json()};
 let datasetId,previous,configured=false;
 const config=plan=>({target_start:plan.target_start,timeframes:plan.timeframes,frequency:plan.frequency,timezone:plan.timezone,daily_minute:plan.daily_minute,overlap_minutes:plan.overlap_minutes});
 try{
  await page.goto(base+'/market-data');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.getByRole('heading',{name:'数据中心',exact:true})).toBeVisible();
  const calendar=JSON.parse(fs.readFileSync(path.join(artifacts,'calendar-history-real-01.json')));
  const record=calendar.records.find(r=>r.source==='dukascopy'&&r.symbol==='EURUSD'&&r.window==='spring');expect(record).toBeTruthy();datasetId=record.dataset_id;
  previous=await get('market-data/datasets/'+datasetId+'/maintenance');
  if(previous.configured){
   // Reruns may only reuse this script's own paused, bounded acceptance plan.
   expect(previous.paused).toBe(true);expect(previous.archived).toBe(false);
   expect(config(previous)).toEqual({target_start:record.start,timeframes:['M1'],frequency:'once',timezone:'UTC',daily_minute:15,overlap_minutes:30});
  }
  const original={target_start:record.start,timeframes:['M1'],frequency:'once',timezone:'UTC',daily_minute:15,overlap_minutes:30};
  await post('market-data/datasets/'+datasetId+'/maintenance',original);configured=true;
  const route=base+'/market-data/datasets/'+datasetId+'?section=maintenance';
  for(const p of [page,peer]){await p.goto(route);await expect(p.getByRole('button',{name:'保存维护设置'})).toBeVisible();await expect(p.getByLabel('目标起始交易日期')).toHaveValue('2026-03-06')}
  await page.getByLabel('更新频率').selectOption('daily');await page.getByLabel('维护时间',{exact:true}).fill('00:30');
  await page.getByRole('button',{name:'保存维护设置'}).click();await expect(page.getByRole('status')).toContainText('维护配置已保存');
  // A future daily schedule creates no work in this bounded edit check.
  await peer.getByLabel('更新频率').selectOption('daily');await peer.getByLabel('维护时间',{exact:true}).fill('00:45');
  const response=peer.waitForResponse(r=>r.url().endsWith('/maintenance')&&r.request().method()==='POST');
  await peer.getByRole('button',{name:'保存维护设置'}).click();expect((await response).status()).toBe(409);
  await expect(peer.getByRole('region',{name:'维护配置冲突'})).toBeVisible();await expect(peer.getByLabel('维护时间',{exact:true})).toHaveValue('00:45');
  expect((await get('market-data/datasets/'+datasetId+'/maintenance')).daily_minute).toBe(30);
  await peer.getByRole('button',{name:'载入最新维护设置'}).click();await expect(peer.getByLabel('维护时间',{exact:true})).toHaveValue('00:30');
  await peer.getByLabel('维护时间',{exact:true}).fill('00:45');await peer.getByRole('button',{name:'保存维护设置'}).click();
  await expect(peer.getByRole('status')).toContainText('维护配置已保存');expect((await get('market-data/datasets/'+datasetId+'/maintenance')).daily_minute).toBe(45);
  report.checks.push('actual two-window stale POST409 preserves edited fields and winning saved plan; explicit latest load permits subsequent save');
  report.checks.push('NY17 spring fixed start displays trading date 2026-03-06 without host timezone conversion');
  expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.failure=String(e);throw e}
 finally{
  if(configured){const current=await get('market-data/datasets/'+datasetId+'/maintenance');const restored=previous.configured?config(previous):{target_start:current.target_start,timeframes:['M1'],frequency:'once',timezone:'UTC',daily_minute:15,overlap_minutes:30};await post('market-data/datasets/'+datasetId+'/maintenance',{...restored,expected_configuration_revision:current.configuration_revision});await post('market-data/datasets/'+datasetId+'/maintenance/control',{action:'pause'});report.cleanup=previous.configured?'own previously paused acceptance configuration restored; no normal dataset changed':'dedicated acceptance plan set to once and paused; previously had no plan; no normal dataset changed';}
  fs.writeFileSync(path.join(artifacts,'maintenance-conflict-real-browser.json'),JSON.stringify(report,null,2)+'\n');await browser.close();
 }
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,cleanup:report.cleanup}));
})().catch(e=>{console.error(e);process.exitCode=1});
