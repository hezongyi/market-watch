// Actual Ubuntu fixed period reads and desktop status; no response/data fixtures.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto(base+'/market-data?tab=composite');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
    const login=page.waitForResponse(r=>r.url().endsWith('/api/login') && r.request().method()==='POST');
    await page.getByRole('button',{name:'登录工作台'}).click();
    expect((await login).status()).toBe(200);
    const response=await page.request.get(base+'/api/market-data/center/composites');
    expect(response.status()).toBe(200);const {items}=await response.json();
    const row=items.find(r=>r.logical_symbol==='EURUSD');expect(row).toBeTruthy();
    await expect.poll(async()=>{
      const detail=await (await page.request.get(base+'/api/market-data/composites/'+row.id)).json();
      return detail.periods.length===9 && detail.periods.every(p=>p.status==='caught_up');
    },{timeout:90000}).toBeTruthy();
    await page.goto(base+'/market-data/composites/'+row.id+'?section=overview');
    const table=page.getByRole('table',{name:'接续周期产物'});
    await expect(table).toBeVisible();await expect(table.getByRole('row')).toHaveCount(10);
    await expect(table.getByText('已处理当前输入',{exact:true})).toHaveCount(9);
    await table.getByRole('cell',{name:'MN',exact:true}).scrollIntoViewIfNeeded();
    await expect(table.getByRole('cell',{name:'MN',exact:true})).toBeInViewport();
    await page.getByRole('region',{name:'接续周期产物滚动区'}).focus();
    await expect(page.getByRole('region',{name:'接续周期产物滚动区'})).toBeFocused();
    checks.push('actual worker persists nine periods and desktop displays their input progress');
    for(const width of [1024,1440,1920]) {
      await page.setViewportSize({width,height:1000});
      const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2);expect(fits).toBeTruthy();
    }
    await page.setViewportSize({width:1024,height:1000});
    await page.evaluate(()=>document.querySelector('.data-center').style.zoom='2');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBeTruthy();
    await page.evaluate(()=>document.querySelector('.data-center').style.zoom='');
    checks.push('period status desktop widths and 200% zoom');
    for(const frame of ['M1','H4','D1','W1','MN']) {
      const result=await page.request.get(base+`/api/market-data/composites/${row.id}/chart?timeframe=${frame}&count=3&input_revision=${row.preparation.input_revision}`);
      expect(result.status()).toBe(200);const data=await result.json();
      expect(data.materialized).toBe(true);expect(data.bounded_partitions).toBe(0);
      expect(data.bars.length).toBeGreaterThan(0);
      expect(data.bars.every(b=>b.composite_revision_id===row.active_revision_id)).toBeTruthy();
    }
    checks.push('actual HTTP five periods read persisted fixed input without raw M1 partitions');
    await page.screenshot({path:path.join(artifacts,'composite-aggregate-desktop.png'),fullPage:true});
    expect(errors).toEqual([]);
    fs.writeFileSync(path.join(artifacts,'composite-aggregate-browser-real.json'),JSON.stringify({passed:true,
      environment:'Ubuntu market-watch-three-layer',base,checks,errors},null,2));
    console.log(JSON.stringify({passed:true,checks:checks.length}));
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
