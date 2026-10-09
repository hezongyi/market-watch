// Draft controls use the real source catalog. The submit response is a scoped
// fixture: it exercises UI mutation/callbacks without scheduling supplier work.
const fs=require('fs'),path=require('path'),{expect}=require('@playwright/test'),f=require('./chart-data-center-fixture.cjs');
const out=path.join(f.root,'artifacts/native-ui-implementation'),report={environment:'Ubuntu isolated Docker; actual native controls, scoped submit fixture',passed:false,checks:[],errors:[]};
(async()=>{const b=await f.launch(),p=await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});const {host,native}=f.frames(p),dc=()=>native().locator('.dc-window');p.on('pageerror',e=>report.errors.push(e.message));
 const record=name=>{report.checks.push({name});console.log('PASS',name)};
 const open=async route=>{await host().evaluate(route=>dataCenter.open(route),route);await expect(dc()).toBeVisible({timeout:20000})};
 let release=()=>{};
 try{
  if(process.env.LOCAL)await f.localNativeAssets(p);
  await p.goto(f.base+'/advanced-charts');await f.login(p);await expect.poll(()=>!!native(),{timeout:30000}).toBeTruthy();await expect(native().getByRole('button',{name:'数据中心',exact:true})).toBeVisible({timeout:30000});
  await open('/market-data/datasets/new');await dc().getByRole('button',{name:'下一步',exact:true}).click();await expect(dc().getByRole('alert')).toContainText('请修正以下字段');
  await dc().getByRole('button',{name:'选择品种',exact:true}).click();const picker=native().locator('[data-dialog-name="选择来源品种"]');await picker.getByRole('tab',{name:'金属',exact:true}).click();await picker.getByRole('searchbox').fill('eurusd');await expect(picker.getByText('没有代码符合您的条件',{exact:true})).toBeVisible({timeout:15000});await picker.getByRole('searchbox').fill('xauusd');await expect(picker.getByText('XAU/USD',{exact:true}).first()).toBeVisible({timeout:15000});await p.keyboard.press('Escape');await expect(picker).toHaveCount(0);await expect(dc()).toBeVisible();await expect(dc().getByLabel('逻辑品种',{exact:true})).toHaveValue('');record('scoped native source picker applies metal filter before pagination; cancelling preserves empty draft and keeps parent open');
  await dc().getByRole('button',{name:'选择品种',exact:true}).click();await picker.getByRole('tab',{name:'全部',exact:true}).click();await picker.getByRole('searchbox').fill('eurusd');await expect(picker.getByText('EUR/USD',{exact:true}).first()).toBeVisible({timeout:15000});await picker.getByText('EUR/USD',{exact:true}).first().click();
  await dc().getByLabel('小数位数',{exact:true}).fill('5');await dc().getByRole('button',{name:'下一步',exact:true}).click();await expect(dc().getByLabel('起始交易日期',{exact:true})).toBeVisible();
  const minute=dc().getByRole('checkbox',{name:'M1',exact:true});await expect(minute).toBeChecked();await expect(minute).toBeDisabled();
  const hourly=dc().getByRole('checkbox',{name:'H1',exact:true});await hourly.uncheck();await expect(hourly).not.toBeChecked();await hourly.check();await expect(hourly).toBeChecked();
  await dc().getByLabel('起始交易日期',{exact:true}).fill('2026-10-07');await dc().getByRole('button',{name:'下一步',exact:true}).click();await expect(dc().getByRole('button',{name:'创建并开始维护',exact:true})).toBeVisible();
  record('creation validates fields; actual native checkbox labels, disabled M1 and checked-state changes work');
  const datasets=await (await p.request.get(f.base+'/api/market-data/center/datasets?page_size=25')).json();const detail=await (await p.request.get(f.base+'/api/market-data/center/datasets/'+datasets.items[0].id)).json();
  let submits=0,body;const held=new Promise(r=>release=r);const submit=async r=>{submits++;body=r.request().postDataJSON();await held;await r.fulfill({json:{dataset:detail,task:{id:crypto.randomUUID()}}}).catch(()=>{});};await p.route('**/api/market-data/center/datasets',async r=>{if(r.request().method()==='POST')await submit(r);else await r.continue();});
  await dc().getByRole('button',{name:'创建并开始维护',exact:true}).evaluate(n=>{n.click();n.click();});await expect.poll(()=>submits).toBe(1);expect(body.dataset.logical_symbol).toBe('EURUSD');expect(body.maintenance.timeframes).toContain('H1');expect(body.maintenance.timeframes).toContain('M1');expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
  await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();await dc().getByRole('button',{name:'放弃修改',exact:true}).click();await expect(dc()).toHaveCount(0);
  await open('/market-data?tab=platform&source=binance&query=BTC');await expect(dc().getByRole('heading',{name:'平台品种',exact:true})).toBeVisible();release();await p.waitForTimeout(400);await expect(dc().getByRole('heading',{name:'平台品种',exact:true})).toBeVisible();expect(submits).toBe(1);await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();
  record('one submit carries correct draft; closing does not cancel submitted mutation and late completion cannot navigate a reopened window');
  expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.errors.push(e.message);await p.screenshot({path:path.join(out,'native-create-failed.png')}).catch(()=>{});throw e;}
 finally{release();fs.writeFileSync(path.join(out,'native-create-report.json'),JSON.stringify(report,null,2));await b.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
