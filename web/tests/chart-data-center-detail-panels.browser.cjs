// Deployed native UI; all former disclosure types, responsive/focus and state preservation.
const fs = require('node:fs'), path = require('node:path'), { expect } = require('@playwright/test'), f = require('./chart-data-center-fixture.cjs');
const out = path.join(f.root, 'artifacts/detail-panel-ui'); fs.mkdirSync(out, { recursive: true });
(async () => {
 const b = await f.launch(), p = await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}), {host,native}=f.frames(p);
 const dc=()=>native().locator('.dc-window'), panel=()=>dc().locator('.dc-detail-panel'), rows=()=>dc().locator('.dc-market-row');
 const report={environment:'Ubuntu isolated Docker; deployed assets; real rows and controlled evidence/error fixtures',passed:false,checks:[],errors:[]};
 let workspace;
 const record=name=>{report.checks.push({name});console.log('PASS',name)};
 const get=async route=>{const r=await p.request.get(f.base+'/api'+route);expect(r.ok()).toBe(true);return r.json()};
 const open=async route=>{await host().evaluate(route=>dataCenter.open(route),route);await expect(dc()).toBeVisible()};
 const close=async()=>{await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();await expect(dc()).toHaveCount(0)};
 const dismiss=async()=>{await p.keyboard.press('Escape');await expect(panel()).toHaveCount(0);await expect(dc()).toBeVisible()};
 try {
  await p.goto(f.base+'/advanced-charts');await f.login(p);
  const {csrf}=await get('/session'), created=await p.request.post(f.base+'/api/advanced-charts/workspaces',{data:{name:'数据中心详情面板验收',symbol:'MWP:EURUSD'},headers:{'X-CSRF-Token':csrf}});expect(created.ok()).toBe(true);workspace=await created.json();
  await p.goto(f.base+'/advanced-charts');await expect.poll(()=>!!native(),{timeout:30000}).toBe(true);await host().waitForFunction(()=>ready&&dataCenter&&widget.activeChart().dataReady(),null,{timeout:60000});
  p.on('pageerror',e=>report.errors.push(e.message));
  const baseline=await host().evaluate(()=>({symbol:widget.activeChart().symbol(),epoch:workspaceEpoch}));
  const datasets=await get('/market-data/center/datasets?page_size=100'), composites=await get('/market-data/center/composites'), d=datasets.items.find(row=>row.latest_version_id), c=composites.items[0];expect(d).toBeTruthy();expect(c).toBeTruthy();
  await open('/market-data?tab=managed');await expect(rows().first()).toBeVisible();
  const first=rows().first(), button=first.getByRole('button',{name:'查看详情',exact:true}), size=await first.boundingBox();await button.click();await expect(panel()).toBeFocused();
  await expect(panel()).toContainText('可用周期');await expect(panel().getByRole('button',{name:'打开图表',exact:true})).toBeVisible();await expect(panel().getByRole('link',{name:'删除历史数据',exact:true})).toBeVisible();expect(await dc().locator('details,summary').count()).toBe(0);
  await expect(dc().locator('.dc-window-content')).toHaveAttribute('data-detail-mode','side');
  const listBox=await dc().locator('.dc-market-list').boundingBox(), panelBox=await panel().boundingBox();expect(listBox.x+listBox.width).toBeLessThanOrEqual(panelBox.x+1);
  const next=rows().nth(1);await next.getByRole('button',{name:'查看详情',exact:true}).click();await expect(panel()).toHaveCount(1);await expect(panel()).toContainText(await next.locator('.dc-symbol-button').innerText());
  await dismiss();await expect(next.getByRole('button',{name:'查看详情',exact:true})).toBeFocused();expect((await first.boundingBox()).height).toBe(size.height);record('desktop side panel preserves compact row height, keeps list/actions accessible, switches rows and restores focus with Escape');
  // Long list: opening and dismissing preserves deep position and query.
  const many=async route=>{const q=new URL(route.request().url()).searchParams,page=Number(q.get('page')||1),size=Number(q.get('page_size')||25);await route.fulfill({json:{items:Array.from({length:90},(_,i)=>({...d,id:'PANEL'+i,display_symbol:'PANEL/'+i})).slice((page-1)*size,page*size),total:90,page,page_size:size}})};
  await close();await p.route('**/api/market-data/center/datasets?*',many);await open('/market-data?tab=managed&query=PANEL&page=3');await expect(rows()).toHaveCount(75);const list=dc().locator('.dc-market-list');await rows().nth(50).scrollIntoViewIfNeeded();const scroll=await list.evaluate(n=>n.scrollTop);await rows().nth(50).getByRole('button',{name:'查看详情',exact:true}).click();await dismiss();expect(await list.evaluate(n=>n.scrollTop)).toBe(scroll);await expect(dc().getByRole('searchbox',{name:'搜索品种',exact:true})).toHaveValue('PANEL');record('deep continuous list keeps search and exact scroll position across detail close');await close();await p.unroute('**/api/market-data/center/datasets?*',many);
  await open('/market-data?tab=composite');await rows().first().getByRole('button',{name:'查看详情',exact:true}).click();await expect(panel()).toContainText('历史基线');await expect(panel().getByRole('button',{name:'打开图表',exact:true})).toBeVisible();await panel().getByRole('link',{name:'管理组合行情',exact:true}).click();await expect(dc().getByRole('button',{name:'使用与健康',exact:true})).toBeVisible();
  await dc().getByRole('button',{name:'接续与修订',exact:true}).click();
  await dc().getByRole('button',{name:'映射复核依据',exact:true}).click();await expect(panel().getByRole('link',{name:'历史产品依据',exact:true})).toBeVisible();await dismiss();
  await dc().getByRole('button',{name:'接续与修订',exact:true}).click();await dc().getByRole('button',{name:'查看固定输入依据',exact:true}).first().click();await expect(panel()).toContainText('固定输入');await dismiss();await close();
  await open('/market-data?tab=composite&view=candidates');await rows().first().getByRole('button',{name:'查看详情',exact:true}).click();await expect(panel()).toContainText('准确来源代码');await expect(panel().getByRole('link',{name:/去维护|配置实时来源/})).toBeVisible();await dismiss();record('existing composites/candidates and mapping/revision evidence retain information and full management entry');await close();
  // Read-only evidence fixtures exercise nonempty and empty intervals without altering PG.
  const evidence=async route=>route.fulfill({json:{items:[{start:1700000000000,end:1700003600000,observed_at:1700004000000,observed_minutes:30,unknown_minutes:10,confirmed_closed_minutes:20,conflict_minutes:0,observed_intervals:[[1700000000000,1700001800000]],unknown_intervals:[[1700001800000,1700002400000]],confirmed_closed_intervals:[[1700002400000,1700003600000]],conflict_intervals:[],session_evidence:[{source:'https://example.com/session',kind:'official',applicability:'验收闭市依据'}]}],total:1}});
  await p.route('**/api/market-data/versions/*/coverage?*',evidence);await open(`/market-data/datasets/${d.id}?section=coverage`);
  for(const [name,text] of [['查看实际观测区间','至'],['查看未知区间','至'],['查看闭市区间与依据','验收闭市依据'],['查看观测冲突','无已知冲突']]){const trigger=dc().getByRole('button',{name,exact:true});await trigger.click();await expect(panel()).toContainText(text);await dismiss();await expect(trigger).toBeFocused()};record('all four coverage evidence controls open the same panel; intervals, citations and empty conflict state remain complete');await close();await p.unroute('**/api/market-data/versions/*/coverage?*',evidence);
  await open(`/market-data/datasets/${d.id}?section=references`);await dc().getByRole('button',{name:/^已保存映射/}).click();await expect(panel()).toBeVisible();await dismiss();await close();
  await open(`/market-data/datasets/${d.id}?section=maintenance`);await expect(dc().getByRole('spinbutton',{name:'重叠复查窗口（分钟）',exact:true})).toBeVisible();expect(await dc().locator('details,summary').count()).toBe(0);await close();
  await open('/market-data/datasets/new?source=oanda');await expect(dc().getByRole('spinbutton',{name:'小数位数',exact:true})).toBeVisible();await close();record('saved mappings use detail panel; advanced editable fields are directly visible and keep native form controls');
  const tasks=async route=>route.fulfill({json:{items:[{id:'PANEL-TASK',dataset_id:d.id,dataset:d,task_kind:'recheck',cursor:1700000000000,controllable:false,status:'configuration_error',desired_state:'running',error:'supplier_unavailable',created_at:1700000000000,started_at:null,updated_at:null,completed_at:null,next_at:null,type:'recheck',start:1700000000000,end:1700003600000}],total:1,page:1,page_size:25}});
  await p.route('**/api/market-data/center/tasks?*',tasks);await open('/market-data?tab=tasks');await dc().getByRole('button',{name:'技术错误详情',exact:true}).click();await expect(panel()).toContainText('supplier_unavailable');await dismiss();await close();await p.unroute('**/api/market-data/center/tasks?*',tasks);record('technical task errors use the same panel without exposing supplier payloads');
  for(const theme of ['Dark','Light']){
   await host().evaluate(theme=>widget.changeTheme(theme),theme);
   for(const width of [1440,768,375]){
    await p.setViewportSize({width,height:900});await open('/market-data?tab=managed');await rows().first().getByRole('button',{name:'查看详情',exact:true}).click();await expect(panel()).toBeInViewport();await expect(panel().getByRole('button',{name:'关闭详情',exact:true})).toBeInViewport();expect(await panel().evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    if(width<1000){await expect(dc().locator('.dc-window-content')).toHaveAttribute('data-detail-mode','full');for(const key of ['Tab','Shift+Tab'])for(let i=0;i<8;i++){await p.keyboard.press(key);expect(await native().evaluate(()=>!!document.activeElement.closest('.dc-detail-panel'))).toBe(true)}}
    await p.screenshot({path:path.join(out,`panel-${theme.toLowerCase()}-${width}.png`)});await dismiss();await expect(rows().first().getByRole('button',{name:'查看详情',exact:true})).toBeFocused();await close();
   }
  }
  record('dark/light at desktop, tablet, 375px: visible close, no overflow, full panel keyboard containment and return focus');
  await p.setViewportSize({width:1440,height:1000});
  await host().evaluate(()=>{window.panelRealVersion=TradingView.version;TradingView.version=()=>"panel-incompatible-version"});
  await host().evaluate(()=>dataCenter.open('/market-data?tab=managed'));
  const fallback=()=>p.frames().find(frame=>frame.url().includes('/chart-data-center?'));
  await expect.poll(()=>!!fallback(),{timeout:20000}).toBe(true);
  const fallbackTrigger=fallback().locator('.dc-market-row').first().getByRole('button',{name:'查看详情',exact:true});
  await fallbackTrigger.click();await expect(fallback().locator('.dc-detail-panel').getByRole('link',{name:'管理行情',exact:true})).toBeVisible();
  await p.keyboard.press('Escape');await expect(fallback().locator('.dc-detail-panel')).toHaveCount(0);await expect(fallbackTrigger).toBeFocused();
  await fallback().getByRole('button',{name:'关闭数据中心',exact:true}).click();await expect.poll(()=>!!fallback()).toBe(false);
  await host().evaluate(()=>{TradingView.version=panelRealVersion});record('version-mismatch compatibility window keeps the same details, management links, Escape and return focus');
  expect(await host().evaluate(()=>({symbol:widget.activeChart().symbol(),epoch:workspaceEpoch}))).toEqual(baseline);expect(report.errors).toEqual([]);report.passed=true;
 }catch(error){report.errors.push(error.message);await p.screenshot({path:path.join(out,'failed.png')}).catch(()=>{});throw error}
 finally {
  if(workspace){const before=await get('/advanced-charts/workspaces'),owned=before.find(row=>row.id===workspace.id);if(owned){const {csrf}=await get('/session'), removed=await p.request.post(f.base+'/api/advanced-charts/workspaces/'+owned.id+'/delete',{data:{revision:owned.revision},headers:{'X-CSRF-Token':csrf}});expect(removed.ok()).toBe(true);const after=await get('/advanced-charts/workspaces');expect(after.map(row=>row.id).sort()).toEqual(before.filter(row=>row.id!==workspace.id).map(row=>row.id).sort());report.cleanup={onlyOwnedWorkspaceDeleted:true}}}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await b.close();
 }
})().catch(error=>{console.error(error.message);process.exitCode=1});
