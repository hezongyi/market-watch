const fixture=require('./chart-data-center-fixture.cjs');
// Ubuntu isolated Docker only. Uses real authenticated APIs and licensed chart.
const {chromium, expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),privateDir=path.join(root,'artifacts/data-center');
const base=fixture.base;
const report={environment:'Ubuntu quant-server Docker',project:'mw-data-center-impl-20261008',base,passed:false,checks:[],errors:[]};
(async()=>{
 const browser=await fixture.launch();
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>report.errors.push(e.message));
 const posts=[];page.on('request',r=>{if(r.method()==='POST')posts.push({path:new URL(r.url()).pathname,body:r.postDataJSON()})});
 const record=(name,data={})=>{report.checks.push({name,...data});console.log('PASS',name)};
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok(),await r.text()).toBeTruthy();return r.json()};
 const post=async(route,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+route,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBeTruthy();return r.json()};
 const host=()=>fixture.frames(page).host();
 const native=()=>fixture.frames(page).native();
 const center=()=>fixture.frames(page).center();
 const open=async()=>{await native().getByRole('button',{name:'数据中心',exact:true}).click();await expect.poll(()=>!!center(),{timeout:15000}).toBeTruthy();await expect(center().getByRole('heading',{name:'自建行情',exact:true})).toBeVisible({timeout:15000})};
 try {
  await page.goto(base+'/market-data');
  await fixture.login(page);
  await expect.poll(()=>!!center(),{timeout:30000}).toBeTruthy();
  await expect(center().getByRole('heading',{name:'自建行情',exact:true})).toBeVisible({timeout:15000});
  expect(new URL(page.url()).pathname).toBe('/advanced-charts');
  const workspace=(await get('advanced-charts/workspaces?limit=1'))[0];
  const originalHost=host(),originalNative=native();
  const state=await host().evaluate(()=>({epoch:workspaceEpoch,studies:widget.activeChart().getAllStudies(),shapes:widget.activeChart().getAllShapes(),symbol:widget.activeChart().symbol()}));
  record('old list URL and authentication target enter one chart dialog',{workspace:workspace.id});
  const count=posts.length;
  for(const name of ['平台品种','组合行情','任务与记录','来源与能力','自建行情']) {
   await center().getByRole('button',{name,exact:true}).click();await expect(center().getByRole('heading',{name,exact:true})).toBeVisible();
  }
  expect(posts.slice(count).filter(p=>/composites\/use|center\/datasets|\/activity|\/tasks$/.test(p.path))).toEqual([]);
  expect(host()).toBe(originalHost);expect(native()).toBe(originalNative);
  expect(await host().evaluate(()=>workspaceEpoch)).toBe(state.epoch);
  record('five sections use pure reads and retain the chart frame');
  for(const width of [1024,1440,1920]) {
   await page.setViewportSize({width,height:1000});
   expect(await center().evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBeTruthy();
   await page.screenshot({path:path.join(privateDir,`window-${width}.png`)});
  }
  await page.setViewportSize({width:1024,height:1000});
  await center().locator('.dc-window').evaluate(e=>e.style.zoom='2');
  await expect(center().getByRole('button',{name:'关闭数据中心'})).toBeVisible();
  await page.screenshot({path:path.join(privateDir,'window-zoom200.png')});
  await center().locator('.dc-window').evaluate(e=>e.style.zoom='');
  await page.setViewportSize({width:1440,height:1000});record('desktop 1024, 1440, 1920 and 200% content zoom');
  await center().getByRole('link',{name:'添加行情',exact:true}).click();
  await center().getByLabel('逻辑品种',{exact:true}).fill('EURUSD');
  await center().getByRole('button',{name:'关闭数据中心'}).click();
  await expect(center().getByRole('alertdialog')).toBeVisible();
  await center().getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(center().getByLabel('逻辑品种',{exact:true})).toHaveValue('EURUSD');
  await center().getByRole('button',{name:'平台品种',exact:true}).click();
  await expect(center().getByRole('alertdialog')).toBeVisible();
  await center().getByRole('button',{name:'放弃修改',exact:true}).click();
  await expect(center().getByRole('heading',{name:'平台品种',exact:true})).toBeVisible();
  record('close and section changes protect unsaved creation input');
  await center().getByRole('button',{name:'关闭数据中心'}).click();
  await expect.poll(()=>!!center()).toBeFalsy();
  await expect(native().getByRole('button',{name:'数据中心',exact:true})).toBeFocused();
  expect(host()).toBe(originalHost);expect(native()).toBe(originalNative);
  record('closing cancels manager frame and returns native toolbar focus');
  await native().getByRole('button',{name:'数据中心',exact:true}).click();
  await expect.poll(()=>!!center()).toBeTruthy();
  await expect(center().getByRole('heading',{name:'平台品种',exact:true})).toBeVisible();
  await center().getByRole('button',{name:'关闭数据中心'}).focus();await page.keyboard.press('Shift+Tab');
  expect(await center().evaluate(()=>document.activeElement?.closest('.dc-window')!==null)).toBeTruthy();
  await page.keyboard.press('Escape');await expect.poll(()=>!!center()).toBeFalsy();
  record('session browse memory, keyboard focus containment and Escape');
  const icons=await native().getByRole('button',{name:'数据中心',exact:true}).count();expect(icons).toBe(1);
  await page.goto(base+'/');await expect(page.getByRole('link',{name:'数据中心',exact:true})).toHaveCount(0);
  record('one toolbar entry and no application sidebar data center entry');
  report.passed=true;
 } finally {
  fs.writeFileSync(path.join(privateDir,'browser-report.json'),JSON.stringify(report,null,2));
  await browser.close();
 }
})().catch(error=>{console.error(error.message);process.exitCode=1});
