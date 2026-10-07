// Actual directory paging and business selection. No new datasets or strategies.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const report={environment:'Ubuntu isolated market-watch-three-layer',base,passed:false,checks:[],errors:[]};
 const writes=[],owned=new Set();
 const dialogState=async(frame,label)=>{(report.dialogStates??=[]).push({label,...await frame.evaluate(()=>({dialogs:[...document.querySelectorAll('dialog')].map(d=>({open:d.open,role:d.className})),active:document.activeElement?.outerHTML.slice(0,180)}))})};
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname)});
 page.on('response',async r=>{if(r.url().endsWith('/api/advanced-charts/workspaces')&&r.request().method()==='POST'&&r.ok())owned.add((await r.json()).id)});
 const get=async route=>{const r=await page.request.get(base+'/api/'+route);expect(r.ok(),await r.text()).toBe(true);return r.json()};
 const post=async(route,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+route,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),await r.text()).toBe(true);return r.json()};
 try{
  await expect.poll(async()=>{try{return(await page.request.get(base+'/readyz')).status()}catch{return 0}},{timeout:90000}).toBe(200);
  await page.goto(base+'/');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('button',{name:'新建预警',exact:true})).toBeVisible({timeout:60000});
  const ids=new Set();let offset=0,total=null,pages=0;
  do{
   const r=await get('market-data/series/page?kind=provider&source=dukascopy&page_size=100&offset='+offset);
   total=r.total;for(const row of r.items){expect(ids.has(row.id)).toBe(false);ids.add(row.id);expect(row.source).toBe('dukascopy')}
   pages++;offset=r.next_offset;
  }while(offset!==null);
  expect(total).toBeGreaterThan(250);expect(ids.size).toBe(total);
  report.directory={total,pages};report.checks.push('complete actual Dukascopy directory paginates beyond 250 without loss or duplicates');
  await page.getByRole('button',{name:'新建预警',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('searchbox',{name:'查找组合行情',exact:true}).fill('EURUSD');
  const picker=dialog.getByRole('combobox',{name:'品种',exact:true});
  await expect.poll(async()=>picker.locator('option').count(),{timeout:60000}).toBeGreaterThan(1);
  const selected=await picker.locator('option').nth(1).getAttribute('value');await picker.selectOption(selected);
  await dialog.getByRole('combobox',{name:'历史来源',exact:true}).selectOption('oanda');
  await expect(picker).toHaveValue(selected);
  await dialog.getByRole('combobox',{name:'聚合日界',exact:true}).selectOption('utc0');
  await expect(picker).toHaveValue(selected);
  await dialog.getByRole('searchbox',{name:'查找组合行情',exact:true}).fill('NO_SUCH_SYMBOL');
  await expect(dialog.getByText('没有符合条件的可用行情。',{exact:true})).toBeVisible();await expect(picker).toHaveValue(selected);
  for(const width of [1024,1440,1920]){await page.setViewportSize({width,height:1000});expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true)}
  await dialog.evaluate(e=>e.style.zoom='2');expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true);
  await dialog.getByRole('combobox',{name:'历史来源',exact:true}).focus();await page.keyboard.press('Tab');
  await expect(dialog.getByRole('combobox',{name:'聚合日界',exact:true})).toBeFocused();
  await dialog.evaluate(e=>e.style.zoom='');await page.keyboard.press('Escape');
  expect(writes.some(p=>/composites\/use|market-data\/activity|provider\/subscribe|\/watches$/.test(p))).toBe(false);
  report.checks.push('strategy filters and no-result retain selection; desktop widths, keyboard, zoom; pure search');
  await page.goto(base+'/replay');
  await expect(page.getByRole('searchbox',{name:'查找自建行情',exact:true})).toBeVisible({timeout:60000});
  await page.getByRole('searchbox',{name:'查找自建行情',exact:true}).fill('EURUSD');
  const historyPicker=page.getByRole('combobox',{name:'品种',exact:true});
  await expect.poll(async()=>historyPicker.locator('option').count(),{timeout:60000}).toBeGreaterThan(1);
  const historySelected=await historyPicker.locator('option').nth(1).getAttribute('value');await historyPicker.selectOption(historySelected);
  await page.getByRole('combobox',{name:'历史来源',exact:true}).selectOption('oanda');await expect(historyPicker).toHaveValue(historySelected);
  await page.getByRole('searchbox',{name:'查找自建行情',exact:true}).fill('NO_SUCH_SYMBOL');
  await expect(page.getByText('没有符合条件的可用行情。',{exact:true})).toBeVisible();await expect(historyPicker).toHaveValue(historySelected);
  report.checks.push('replay source filtering and empty result preserve explicit fixed historical input');
  await page.goto(base+'/advanced-charts?platform=MWP:OANDA:EUR_USD');
  await page.frameLocator('iframe[title="专业图表工作区"]').locator('#chart').waitFor();
  const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready,null,{timeout:120000});
  const toolbar=frame.childFrames()[0];
  await toolbar.getByText('行情搜索',{exact:true}).click();
  const search=frame.getByRole('dialog');
  await expect(search.getByLabel('行情类型')).toHaveValue('provider');
  await search.getByLabel('历史来源').selectOption('dukascopy');
  await expect(search.getByRole('button',{name:'下一页行情',exact:true})).toBeEnabled({timeout:60000});
  const first=await search.locator('.mw-series-result').allTextContents();
  await search.getByRole('button',{name:'下一页行情',exact:true}).click();
  await expect(search.locator('nav')).toContainText('第 2 页');
  const second=await search.locator('.mw-series-result').allTextContents();expect(second.some(x=>first.includes(x))).toBe(false);
  for(const width of [1024,1440,1920]){await page.setViewportSize({width,height:1000});expect(await search.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true)}
  await search.evaluate(e=>e.style.zoom='2');expect(await search.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true);
  await search.getByLabel('历史来源').focus();await page.keyboard.press('Tab');await expect(search.locator('.mw-series-result').first()).toBeFocused();
  await search.evaluate(e=>e.style.zoom='');
  const symbolBeforeError=await frame.evaluate(()=>widget.activeChart().symbol());
  await page.route('**/api/market-data/series/page?**',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"acceptance: search temporarily unavailable"}'}));
  await search.getByLabel('查找品种').fill('EURUSD');
  await expect(search.getByRole('button',{name:'重试搜索',exact:true})).toBeVisible();
  await expect(search.locator('.mw-series-result').first()).toBeDisabled();
  expect(await frame.evaluate(()=>widget.activeChart().symbol())).toBe(symbolBeforeError);
  await page.unroute('**/api/market-data/series/page?**');
  await search.getByRole('button',{name:'重试搜索',exact:true}).click();
  await expect(search.locator('.mw-series-result').first()).toBeEnabled({timeout:60000});
  await search.getByLabel('行情类型').selectOption('history');await search.getByLabel('查找品种').fill('EURUSD');
  await expect(search.locator('.mw-series-result').first()).toContainText('自建',{timeout:60000});
  await expect(search.locator('.mw-series-result').first()).toBeEnabled();
  const before=await frame.evaluate(()=>widget.activeChart().symbol());
  await dialogState(frame,'before-close');await search.getByRole('button',{name:'关闭行情搜索',exact:true}).click();await dialogState(frame,'after-close');await expect(search).toHaveCount(0);expect(await frame.evaluate(()=>widget.activeChart().symbol())).toBe(before);
  await toolbar.getByText('行情搜索',{exact:true}).click();
  await search.getByLabel('行情类型').selectOption('history');await search.getByLabel('查找品种').fill('EURUSD');
  await expect(search.locator('.mw-series-result').first()).toContainText('自建',{timeout:60000});
  await expect(search.locator('.mw-series-result').first()).toBeEnabled();
  await search.locator('.mw-series-result').first().click();
  await expect.poll(()=>frame.evaluate(()=>MWSeries.decode(widget.activeChart().symbol()).series_kind),{timeout:60000}).toBe('history');
  await toolbar.getByText('行情搜索',{exact:true}).click();await expect(search.getByLabel('行情类型')).toHaveValue('history');
  await page.screenshot({path:path.join(artifacts,'search-pagination-chart-history.png'),fullPage:true});
  await search.getByRole('button',{name:'关闭行情搜索',exact:true}).click();
  await expect(search).toHaveCount(0);
  for(const theme of ['Light','Dark']){
   await frame.evaluate(theme=>widget.changeTheme(theme),theme);
   await toolbar.getByText('行情搜索',{exact:true}).click();
   expect(await search.getAttribute('data-theme')).toBe(theme==='Light'?'light':null);
   await search.getByLabel('查找品种').focus();await page.keyboard.press('Escape');
   await expect(search).toHaveCount(0);
   await expect(toolbar.getByText('行情搜索',{exact:true})).toBeFocused();
  }
  report.checks.push('licensed chart pure paginated native directory, explicit history switch/open, current-kind default and cancel preserve binding');
  report.checks.push('licensed picker desktop/keyboard/200% content zoom, sandbox-safe close, light/dark Escape focus restore; injected HTTP 503 disables stale rows and retry preserves binding');
  expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.failure=String(e);await page.screenshot({path:path.join(artifacts,'search-pagination-failure.png'),fullPage:true});throw e}
 finally{
  await page.goto(base+'/market-data');
  for(const id of owned){const row=(await get('advanced-charts/workspaces')).find(r=>r.id===id);if(row)await post('advanced-charts/workspaces/'+id+'/delete',{revision:row.revision})}
  fs.writeFileSync(path.join(artifacts,'search-pagination-browser.json'),JSON.stringify(report,null,2)+'\n');await browser.close();
 }
 console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
})().catch(e=>{console.error(e);process.exit(1)});
