// Actual Ubuntu creation/search/health UI; only our own watch is cancelled.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
const records=JSON.parse(fs.readFileSync(path.join(artifacts,'cross-source-setup.json'))).records;
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],checks=[],writes=[];let owned=null;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname)});
 const get=async p=>{const r=await page.request.get(base+'/api/'+p);expect(r.ok()).toBe(true);return r.json()};
 try{
  await expect.poll(async()=>{try{return(await page.request.get(base+'/readyz')).status()}catch{return 0}}, {timeout:120000}).toBe(200);
  await page.goto(base+'/');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('button',{name:'新建预警',exact:true})).toBeVisible({timeout:60000});
  const before=await get('market-data/center/composites');
  const open=page.getByRole('button',{name:'新建预警',exact:true});
  await open.click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('combobox',{name:'行情输入',exact:true})).toHaveValue('composite');
  await expect(dialog.getByRole('button',{name:'开启监控',exact:false})).toBeDisabled();
  const search=dialog.getByRole('searchbox',{name:'查找组合行情',exact:true});
  await search.fill('EURUSD');
  const record=records.find(r=>r.symbol==='EURUSD');
  const picker=dialog.getByRole('combobox',{name:'品种',exact:true});
  await expect(picker.locator(`option[value="${record.composite_id}"]`)).toBeAttached();
  expect(await picker.locator(`option[value="${record.composite_id}"]`).textContent()).toContain('Dukascopy → OANDA Practice');
  expect(await picker.locator(`option[value="${record.composite_id}"]`).textContent()).toContain('NY17');
  await picker.selectOption(record.composite_id);
  await search.fill('NO_SUCH_COMPOSITE_SYMBOL');
  await expect(dialog.getByText('没有符合条件的可用行情。',{exact:true})).toBeVisible();
  await expect(picker).toHaveValue(record.composite_id);
  expect(writes.some(p=>/composites\/use|market-data\/activity|\/watches$/.test(p))).toBe(false);
  const after=await get('market-data/center/composites');
  expect(after.items.map(r=>[r.id,r.usage])).toEqual(before.items.map(r=>[r.id,r.usage]));
  checks.push('default composite search is pure, identifies historical/live source and NY17; no-result search retains selected input');
  for(const width of [1024,1440,1920]){
   await page.setViewportSize({width,height:1000});
   const box=await dialog.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+2);
   expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true);
  }
  await page.setViewportSize({width:1024,height:1000});
  await dialog.evaluate(e=>e.style.zoom='2');
  expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+2)).toBe(true);
  await dialog.getByRole('combobox',{name:'接缝依赖政策',exact:true}).focus();
  await expect(dialog.getByRole('combobox',{name:'接缝依赖政策',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('dialog'))).toBe(true);
  await dialog.evaluate(e=>e.style.zoom='');
  checks.push('desktop 1024/1440/1920, 200 percent content zoom and keyboard focus in modal');
  await dialog.getByRole('combobox',{name:'行情输入',exact:true}).selectOption('legacy');
  await expect(dialog.getByRole('searchbox',{name:'查找组合行情',exact:true})).toHaveCount(0);
  await dialog.getByRole('combobox',{name:'行情输入',exact:true}).selectOption('composite');
  await expect(picker).toHaveValue(record.composite_id);
  expect(await dialog.getByRole('combobox',{name:'策略',exact:true}).locator('option').allTextContents()).toEqual([
   '回落 / 反弹结束','前日高低点突破','价格穿越','双均线交叉（SMA）']);
  await dialog.getByRole('combobox',{name:'策略',exact:true}).selectOption('price');
  await dialog.getByRole('combobox',{name:'确认周期',exact:true}).selectOption('M1');
  await dialog.getByLabel('目标价格',{exact:true}).fill('999999');
  await dialog.getByLabel('预警名称',{exact:true}).fill('browser-owned composite watch '+Date.now());
  await expect(dialog.getByText(/提交时固定历史基线/)).toBeVisible();
  expect(await dialog.locator('form').evaluate(form=>Array.from(form.elements)
    .filter(e=>e.willValidate&&!e.validity.valid).map(e=>({name:e.getAttribute('type'),value:e.value,message:e.validationMessage})))).toEqual([]);
  await page.screenshot({path:path.join(artifacts,'composite-watches-dialog-real.png'),fullPage:true});
  const created=page.waitForResponse(r=>r.url().endsWith('/api/watches')&&r.request().method()==='POST',{timeout:60000});
  await dialog.getByRole('button',{name:'开启监控',exact:false}).click();
  const response=await created;expect(response.status()).toBe(201);owned=await response.json();
  expect(owned.market_identity.composite_revision_id).toBe(record.revision_id);
  expect(owned.health).toBe('warming');expect(owned.rule.kind).toBe('price');
  const row=page.locator('.watch-row').filter({hasText:owned.name});
  await expect(row).toBeVisible();await expect(row.getByText(/固定修订/)).toBeVisible();
  await expect(row.getByText(/可判断/)).toBeVisible({timeout:120000});
  await page.screenshot({path:path.join(artifacts,'composite-watches-ready-real.png'),fullPage:true});
  checks.push('all four kinds remain available, explicit legacy option, submission pins revision and UI shows actual readiness');
  await page.reload();await expect(row).toBeVisible();await expect(row.getByText(/固定修订/)).toBeVisible();
  await row.getByRole('button',{name:'取消监控',exact:true}).click();
  await expect(row.getByText('已取消',{exact:true})).toBeVisible();
  checks.push('durable fixed watch survives reload and own cancellation is visible');
  expect(errors).toEqual([]);
  fs.writeFileSync(path.join(artifacts,'composite-watches-browser-real.json'),JSON.stringify({passed:true,environment:'Ubuntu market-watch-three-layer',checks,errors,watch_id:owned.id},null,2)+'\n');
  console.log(JSON.stringify({passed:true,checks}));
 }finally{
  if(owned){
   const auth=await page.request.post(base+'/api/login',{data:JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json')))});
   const session=await auth.json();await page.request.post(base+'/api/watches/'+owned.id+'/cancel',{headers:{'X-CSRF-Token':session.csrf},data:{}})}
  await browser.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1});
