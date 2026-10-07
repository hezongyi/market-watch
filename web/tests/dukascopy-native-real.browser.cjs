// Actual Ubuntu supplier/native chart and read-only data center acceptance.
const {chromium, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const artifacts = path.join(root, 'artifacts/data-integration');
const base = 'http://127.0.0.1:16629';
const login = JSON.parse(fs.readFileSync(path.join(artifacts, 'three-layer-login.json')));
(async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width:1440,height:1000}});
  const report = {environment:'Ubuntu isolated market-watch-three-layer',base,passed:false,checks:[],pages:[],errors:[]};
  const owned = new Set(), mutations = [];
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', r => {if(r.method()==='POST')mutations.push(new URL(r.url()).pathname)});
  page.on('response', async r => {
    if(r.url().includes('/api/charts/history-loads/')){
      const result=await r.json().catch(()=>({}));
      fs.writeFileSync(path.join(artifacts,'dukascopy-native-chart-load.json'),JSON.stringify(result,null,2));
    }
    if(r.url().endsWith('/api/advanced-charts/workspaces')&&r.request().method()==='POST'&&r.ok()){
      const row=await r.json();owned.add(row.id);
    }
  });
  const get = async route => {
    const response=await page.request.get(base+'/api/'+route);
    expect(response.ok(), route+' '+response.status()).toBe(true);return response.json();
  };
  const post = async (route,data) => {
    const {csrf}=await get('session');
    const response=await page.request.post(base+'/api/'+route,{data,headers:{'X-CSRF-Token':csrf}});
    expect(response.ok(),route+' '+response.status()+' '+await response.text()).toBe(true);return response.json();
  };
  try {
    await expect.poll(async ()=>(await page.request.get(base+'/readyz')).status(),{timeout:60000}).toBe(200);
    await page.goto(base+'/market-data?tab=platform&source=dukascopy&query=EURUSD');
    await page.getByLabel('管理员密码').fill(login.password);
    await page.getByRole('button',{name:'登录工作台'}).click();
    await expect(page.getByRole('link',{name:'打开平台图表'})).toBeVisible();
    await expect(page.getByText('来源未提供确认标记；按周期结束时间显示')).toBeVisible();
    const directory=await get('market-data/center/platform?source=dukascopy&page_size=100');
    expect(directory.total).toBeGreaterThan(250);
    const ids=new Set();
    for(let p=1;p<=Math.ceil(directory.total/100);p++){
      for(const row of (await get('market-data/center/platform?source=dukascopy&page_size=100&page='+p)).items){
        expect(ids.has(row.id)).toBe(false);ids.add(row.id);
      }
    }
    expect(ids.size).toBe(directory.total);
    const eur=(await get('market-data/center/platform?source=dukascopy&query=EURUSD')).items[0];
    expect(eur.history_precision).toBe(null);
    expect(mutations.some(p=>/demand|subscription|center\/datasets/.test(p))).toBe(false);
    report.checks.push('complete SDK directory paginated; browsing does not create datasets/live demand');
    for(const width of [1024,1440,1920]){
      await page.setViewportSize({width,height:1000});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await page.setViewportSize({width:1024,height:1000});
    await page.evaluate(()=>document.querySelector('.data-center').style.zoom='2');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('link',{name:'打开平台图表'}).focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(()=>document.activeElement.textContent)).toBe('添加为自建行情');
    await page.screenshot({path:path.join(artifacts,'dukascopy-native-center-zoom.png'),fullPage:true});
    report.checks.push('desktop 1024/1440/1920, keyboard and 200 percent content zoom');
    await page.getByRole('link',{name:'添加为自建行情'}).click();
    await expect(page.getByRole('heading',{name:'添加自建行情'})).toBeVisible();
    await page.getByText('高级登记：价格精度',{exact:true}).click();
    expect(await page.getByLabel('小数位数').inputValue()).toBe('');
    report.checks.push('display precision is not silently used for history registration');
    const before=Date.parse('2026-10-01T00:00:00Z');
    for(const frame of ['M1','M5','M15','M30','H1','H4','D1','W1','MN']){
      const body={instrument:eur.id,series_kind:'provider',timeframe:frame,before,limit:4};
      const first=await post('charts/data',body),second=await post('charts/data',body);
      expect(first.bars).toHaveLength(4);
      expect(second.bars).toEqual(first.bars);expect(second.cache_hit).toBe(true);
      expect(first.history_boundary).toBe(false);expect(first.has_more).toBe(true);
      expect(first.calendar).toBe('dukascopy_native_utc');
      for(const bar of first.bars){expect(bar.chart_time).toBeLessThan(before);expect(bar.source_confirmed).toBe(null)}
      const older=await post('charts/data',{...body,before:first.bars[0].chart_time});
      expect(older.bars[older.bars.length-1].chart_time).toBeLessThan(first.bars[0].chart_time);
      report.pages.push({frame,before,bars:first.bars,cache_reused:second.cache_hit});
    }
    report.checks.push('nine actual supplier native periods, exclusive backward pages and durable cache reuse');
    await page.goto(base+'/market-data?tab=platform&source=dukascopy&query=EURUSD');
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('link',{name:'打开平台图表'}).click();
    await page.frameLocator('iframe[title="专业图表工作区"]').locator('#chart').waitFor();
    const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
    await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready,null,{timeout:120000});
    await expect.poll(()=>frame.evaluate(()=>MWSeries.decode(widget.activeChart().symbol()).symbol),{timeout:120000}).toBe(eur.id);
    await frame.waitForFunction(()=>[...lastHistory.keys()].some(k=>k.includes('DUKA:')),null,{timeout:120000});
    for(const resolution of ['240','1D','1M']){
      await frame.evaluate(r=>widget.activeChart().setResolution(r),resolution);
      await expect.poll(()=>frame.evaluate(()=>widget.activeChart().resolution()),{timeout:60000}).toBe(resolution);
      await frame.waitForFunction(()=>!MWNativeNavigation.busy(),null,{timeout:120000});
      await page.screenshot({path:path.join(artifacts,`dukascopy-native-chart-${resolution}.png`),fullPage:true});
    }
    report.checks.push('real licensed native chart opens exact Dukascopy identity and H4/D1/MN');
    expect(report.errors).toEqual([]);
    report.passed=true;
  } catch(error) {
    await page.screenshot({path:path.join(artifacts,'dukascopy-native-chart-failure.png'),fullPage:true});
    const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
    if(frame)report.failure=await frame.evaluate(()=>({ready:typeof ready==='undefined'?null:ready,
      histories:[...lastHistory.entries()],loads:MWNativeNavigation.diagnostics(),
      symbol:typeof widget==='undefined'?null:widget.activeChart().symbol()})).catch(e=>({error:String(e)}));
    throw error;
  } finally {
    await page.goto(base+'/market-data?tab=platform&source=dukascopy');
    for(const id of owned){
      const row=(await get('advanced-charts/workspaces')).find(x=>x.id===id);
      if(row)await post('advanced-charts/workspaces/'+id+'/delete',{revision:row.revision});
    }
    fs.writeFileSync(path.join(artifacts,'dukascopy-native-browser-real.json'),JSON.stringify(report,null,2)+'\n');
    await browser.close();
  }
  console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
})().catch(e=>{console.error(e);process.exit(1)});
