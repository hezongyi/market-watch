// Serial acceptance against Ubuntu isolated Docker and the actual licensed UI.
const fs=require('node:fs'),path=require('node:path');
const {expect}=require('@playwright/test');const f=require('./chart-data-center-fixture.cjs');
const out=path.join(f.root,'artifacts/native-ui-implementation');fs.mkdirSync(out,{recursive:true});
const report={environment:'Ubuntu local Docker',project:'mw-data-center-review-20261008',passed:false,checks:[],errors:[]};
(async()=>{
 const b=await f.launch(),p=await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});const {host,native}=f.frames(p);
 p.on('pageerror',e=>{report.errors.push(e.message);console.log('PAGEERROR',e.message)});
 const record=(name,data={})=>{report.checks.push({name,...data});console.log('PASS',name)};
 const get=async url=>{const r=await p.request.get(f.base+'/api'+url);expect(r.ok(),await r.text()).toBeTruthy();return r.json()};
 const post=async(url,data)=>{const {csrf}=await get('/session');const r=await p.request.post(f.base+'/api'+url,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBeTruthy();return r.json()};
 const dc=()=>native().locator('.dc-window');
 const select=async(label,text)=>{await dc().getByRole('button',{name:label,exact:true}).click();await native().getByRole('option',{name:text,exact:true}).click();};
 const open=async()=>{await native().getByRole('button',{name:'数据中心',exact:true}).click();await expect(dc()).toBeVisible({timeout:30000});};
 const close=async()=>{await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();await expect(dc()).toHaveCount(0);await expect(native().getByRole('button',{name:'数据中心',exact:true})).toBeFocused().catch(async error=>{console.log('FOCUS',await native().evaluate(()=>({active:document.activeElement.outerHTML,buttons:[...document.querySelectorAll('.mw-data-center-button')].map(n=>({html:n.outerHTML,visibility:getComputedStyle(n).visibility,display:getComputedStyle(n).display,rect:n.getBoundingClientRect().toJSON()}))})));throw error;});};
 let workspace;
 try {
  // LOCAL is only for pre-build debugging; delivery runs must omit it.
  if(process.env.LOCAL) await f.localNativeAssets(p);
  await p.goto(f.base+'/advanced-charts');await f.login(p);await expect(p.getByLabel('管理员密码')).toHaveCount(0);
  workspace=await post('/advanced-charts/workspaces',{name:'原生数据中心逐项验收'});report.workspace=workspace.id;
  await p.goto(f.base+'/advanced-charts');await expect.poll(()=>!!native(),{timeout:40000}).toBeTruthy();
  await expect(native().getByRole('button',{name:'数据中心',exact:true})).toBeVisible({timeout:30000});
  await open();await expect(dc().getByRole('heading',{name:'自建行情',exact:true})).toBeVisible();await expect(dc().getByText('正在读取数据…',{exact:true})).toHaveCount(0,{timeout:15000});
  expect(p.frames().filter(fr=>fr.url().includes('/chart-data-center?'))).toHaveLength(0);
  expect(await native().locator('[data-name="mw-data-center-dialog"] .mw-data-center-title svg').count()).toBe(1);
  expect(await native().locator('[data-native-component=sidebar]').count()).toBe(1);
  expect(await native().locator('[data-native-component=sidebarItem]').count()).toBe(5);
  expect(await native().locator('[data-native-component=search] input[role=searchbox]').count()).toBe(1);
  expect(await dc().getByRole('button',{name:'筛选与搜索'}).isVisible()).toBe(false);
  expect(await native().getByRole('button',{name:'行情搜索',exact:true}).count()).toBe(0);
  record('cold open uses actual native shell/sidebar/search; one header and no duplicate market-search entry');
  const baseline=await host().evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution()}));
  for(const tab of ['平台行情','组合行情','任务与记录','来源与能力','自建行情']) {
   await dc().getByRole('button',{name:tab,exact:true}).click();await expect(dc().getByRole('heading',{name:tab,exact:true,includeHidden:true})).toBeAttached();
  }
  expect(await host().evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution()}))).toEqual(baseline);
  record('five sections preserve chart identity');
  for(const theme of ['Dark','Light']) {
   await host().evaluate(theme=>widget.changeTheme(theme),theme);await expect(dc()).toHaveAttribute('data-theme',theme.toLowerCase());
   for(const width of [1024,1440,1920]) {
    await p.setViewportSize({width,height:1000});
    const box=await native().locator('[data-name="mw-data-center-dialog"]').boundingBox();expect(box.width).toBeLessThanOrEqual(width);expect(box.x).toBeGreaterThanOrEqual(0);
    expect(await dc().evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    await p.screenshot({path:path.join(out,`native-${theme.toLowerCase()}-${width}.png`)});
   }
  }
  await p.setViewportSize({width:1440,height:1000});
  // Browser viewport contraction exercises native adaptive layout. Product
  // mobile chart mode is read-only; this retains the desktop session.
  for(const width of [768,540,375]) {await p.setViewportSize({width,height:900});expect(await dc().evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);await expect(native().getByRole('button',{name:'关闭数据中心'})).toBeVisible();await p.screenshot({path:path.join(out,`native-narrow-${width}.png`)});}
  await p.setViewportSize({width:1440,height:1000});
  const before=await native().locator('[data-name="mw-data-center-dialog"]').boundingBox();const title=await native().locator('.mw-data-center-title').boundingBox();
  await p.mouse.move(title.x+60,title.y+10);await p.mouse.down();await p.mouse.move(title.x+130,title.y+50,{steps:5});await p.mouse.up();
  const after=await native().locator('[data-name="mw-data-center-dialog"]').boundingBox();expect(after.x).not.toBe(before.x);await close();await open();
  record('dark/light, 375–1920 widths, centered window, native dragging and close focus');
  await dc().getByRole('link',{name:'添加行情',exact:true}).click();await expect(dc().getByRole('heading',{name:'添加自建行情'})).toBeVisible();
  await dc().getByLabel('逻辑品种',{exact:true}).fill('EURUSD');await native().getByRole('button',{name:'关闭数据中心'}).click();
  await expect(dc().getByRole('alertdialog')).toBeVisible();await dc().getByRole('button',{name:'继续编辑'}).click();await expect(dc().getByLabel('逻辑品种',{exact:true})).toHaveValue('EURUSD');
  await dc().getByRole('button',{name:'平台行情',exact:true}).click();await expect(dc().getByRole('alertdialog')).toBeVisible();await p.keyboard.press('Escape');await expect(dc().getByRole('alertdialog')).toHaveCount(0);await expect(dc()).toBeVisible();
  await dc().getByRole('button',{name:'平台行情',exact:true}).click();await dc().getByRole('button',{name:'放弃修改'}).click();await expect(dc().getByRole('heading',{name:'平台行情',exact:true,includeHidden:true})).toBeAttached();
  record('dirty close/switch protects input; Escape cancels only the dirty warning');
  await select('来源','Yahoo');await dc().getByRole('searchbox',{name:'搜索品种',exact:true}).fill('MSFT');
  await expect(dc().locator('[data-name="symbol-search-dialog-content-item"]')).toHaveCount(1,{timeout:15000});await expect(dc().locator('[data-name="symbol-search-dialog-content-item"]')).toContainText('微软');
  await p.screenshot({path:path.join(out,'native-yahoo.png')});
  await select('来源','Binance');await dc().getByRole('searchbox',{name:'搜索品种',exact:true}).fill('BTC/USDT');await expect(dc().locator('[data-name="symbol-search-dialog-content-item"]')).toHaveCount(1,{timeout:15000});await expect(dc().locator('[data-name="symbol-search-dialog-content-item"]')).toContainText('BTC/USDT');
  record('Yahoo MSFT and Binance BTC/USDT directory and native filters');
  await dc().getByRole('button',{name:'自建行情',exact:true}).click();await dc().getByRole('link',{name:'添加行情',exact:true}).click();
  const beforePick=await host().evaluate(()=>widget.activeChart().symbol());await dc().getByRole('button',{name:'选择品种',exact:true}).click();
  const picker=native().locator('[data-dialog-name="选择来源品种"]');await expect(picker).toBeVisible({timeout:10000});
  await picker.getByRole('searchbox').fill('eurusd');await expect(picker.getByText('EUR/USD',{exact:true}).first()).toBeVisible({timeout:15000});await picker.getByText('EUR/USD',{exact:true}).first().click();
  await expect(picker).toHaveCount(0);await expect(dc().getByLabel('逻辑品种',{exact:true})).toHaveValue('EURUSD');expect(await host().evaluate(()=>widget.activeChart().symbol())).toBe(beforePick);
  record('actual native symbol picker fills a draft and keeps chart unchanged');
  await dc().getByRole('button',{name:'平台行情',exact:true}).click();await dc().getByRole('button',{name:'放弃修改'}).click();
  await close();
  // Native input semantics and focus trap, then unmount cycles.
  await open();await dc().getByRole('searchbox',{name:'搜索品种',exact:true}).focus();await p.keyboard.press('Escape');await expect(dc()).toHaveCount(0);
  for(let i=0;i<3;i++){await open();await close();}expect(await native().locator('.mw-data-center-business').count()).toBe(0);
  record('Escape closes native center; repeated open/close releases business roots');
  expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.errors.push(e.message);await p.screenshot({path:path.join(out,'native-integration-failed.png')}).catch(()=>{});throw e;}
 finally {fs.writeFileSync(path.join(out,'native-integration-report.json'),JSON.stringify(report,null,2));await b.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
