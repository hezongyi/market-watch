// Actual cross-source fixed inputs, desktop data center and chart rendering.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration'),base='http://127.0.0.1:16629';
const input=JSON.parse(fs.readFileSync(path.join(artifacts,'cross-source-check.json')));
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/market-data?tab=composite');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('heading',{name:'数据中心',exact:true})).toBeVisible();
  const get=async path=>{const r=await page.request.get(base+'/api/market-data/'+path);expect(r.ok()).toBe(true);return r.json()};
  const before=await get('center/composites');
  for(const record of input.records){
   await page.goto(base+`/market-data/composites/${record.composite_id}?section=overview`);
   await expect(page.getByRole('heading',{name:record.symbol+' 组合行情',exact:true})).toBeVisible();
   await expect(page.getByText(/Dukascopy → OANDA Practice/).first()).toBeVisible();
   await expect(page.getByRole('table',{name:'接续周期产物'}).getByRole('row')).toHaveCount(10);
   for(const width of [1024,1440,1920]){
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
   }
   await page.setViewportSize({width:1024,height:1000});
   await page.evaluate(()=>document.querySelector('.data-center').style.zoom='2');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
   await page.getByRole('region',{name:'接续周期产物滚动区'}).focus();
   await expect(page.getByRole('region',{name:'接续周期产物滚动区'})).toBeFocused();
   await page.evaluate(()=>document.querySelector('.data-center').style.zoom='');
   await page.getByRole('button',{name:'接续与修订',exact:true}).click();
   await expect(page.getByRole('heading',{name:'固定分段归属',exact:true})).toBeVisible();
   await page.screenshot({path:path.join(artifacts,`cross-source-${record.symbol}-seam.png`),fullPage:true});
   for(const frame of ['M1','H4','D1','W1','MN']){
    const data=await get(`composites/${record.composite_id}/chart?timeframe=${frame}&count=3&revision_id=${record.revision_id}&input_revision=${record.input_revision}&before=${record.validation_end}`);
    expect(data.materialized).toBe(true);expect(data.bounded_partitions).toBe(0);
    expect(data.bars.length).toBeGreaterThan(0);
    expect(data.history_version_id).toBe(record.history_version_id);
    if(['W1','MN'].includes(frame)){
     const mixed=data.bars.find(b=>b.mixed_source);expect(mixed).toBeTruthy();
     expect(mixed.volume).toBe(null);expect(mixed.volume_kind).toBe('unavailable');
     expect(new Set(mixed.segments.map(s=>s.source_id)).size).toBe(2);
    }
   }
   checks.push(record.symbol+' actual fixed M1/H4/D1/W1/MN with preserved cross-source volume evidence');
  }
  const after=await get('center/composites');
  expect(after.items.map(r=>[r.id,r.usage])).toEqual(before.items.map(r=>[r.id,r.usage]));
  checks.push('management/seam browsing preserves definitions and demand; desktop widths, keyboard and 200 percent zoom');
  for(const record of input.records){
   await page.goto(base+`/market-data/composites/${record.composite_id}?section=chart`);
   await expect(page.getByRole('img',{name:/K 线图/})).toBeVisible({timeout:60000});
   await page.getByLabel('周期',{exact:true}).selectOption('H4');
   await expect(page.getByRole('img',{name:/K 线图/})).toBeVisible();
   await page.screenshot({path:path.join(artifacts,`cross-source-${record.symbol}-chart.png`),fullPage:true});
  }
  checks.push('actual EURUSD and XAUUSD composite chart renders and H4 selection');
  expect(errors).toEqual([]);
  fs.writeFileSync(path.join(artifacts,'cross-source-browser-real.json'),JSON.stringify({passed:true,environment:'Ubuntu market-watch-three-layer',checks,errors},null,2)+'\n');
  console.log(JSON.stringify({passed:true,checks}));
 }finally{await page.goto(base+'/market-data');await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
