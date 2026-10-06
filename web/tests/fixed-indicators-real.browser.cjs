// Real Ubuntu API and licensed native chart; no synthetic price responses.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),artifacts=path.join(root,'artifacts/data-integration');
const base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],responses=[],checks=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',async response=>{
   if(response.url().endsWith('/api/charts/data') && response.request().method()==='POST') {
    const query=response.request().postDataJSON();
    if(query.indicators?.length)responses.push({query,status:response.status(),page:await response.json()});
   }
 });
 try {
  await page.goto(base+'/market-data');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  const login=page.waitForResponse(r=>r.url().endsWith('/api/login'));
  await page.getByRole('button',{name:'登录工作台'}).click();expect((await login).status()).toBe(200);
  const catalog=await(await page.request.get(base+'/api/market-data/series/search?query=EURUSD')).json();
  const history=catalog.find(row=>row.series_kind==='history' && row.historical_source==='oanda' && row.calendar==='ny17');
  const composite=catalog.find(row=>row.series_kind==='composite' && row.historical_source==='oanda' && row.calendar==='ny17');
  expect(history).toBeTruthy();expect(composite).toBeTruthy();
  await page.goto(base+'/advanced-charts');
  await page.locator('iframe[title="专业图表工作区"]').waitFor({timeout:30000});
  await expect.poll(()=>page.frames().some(frame=>frame.url().startsWith('http://127.0.0.1:16630/'))).toBeTruthy();
  const frame=page.frames().find(frame=>frame.url().startsWith('http://127.0.0.1:16630/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined' && ready && !loading && widget.activeChart().dataReady(),null,{timeout:60000});
  for(const row of [history,composite]) {
    await frame.evaluate(ticker=>widget.activeChart().setSymbol(ticker),row.ticker);
    await frame.waitForFunction(ticker=>MWSeries.same(widget.activeChart().symbol(),ticker) && widget.activeChart().dataReady(),row.ticker,{timeout:60000});
    await frame.evaluate(()=>widget.activeChart().setResolution('1'));
    await frame.waitForFunction(()=>widget.activeChart().resolution()==='1' && widget.activeChart().dataReady());
    const name=row.series_kind==='history'?'EMA':'RSI';
    const study=await frame.evaluate(name=>widget.activeChart().createStudy('守望 Python '+name,false,false,{period:31}),name);
    expect(study).toBeTruthy();
    await expect.poll(()=>responses.some(result=>result.query.instrument===row.id && result.query.indicators[0].name===name &&
      result.status===200 && result.page.indicator_progress?.every(item=>item.status==='complete') &&
      result.page.indicators.some(indicator=>indicator.series.some(series=>series.values.some(value=>value.value!==null)))),
      {timeout:120000}).toBeTruthy();
    await expect.poll(()=>frame.evaluate(id=>widget.activeChart().getAllStudies().some(study=>study.id===id),study)).toBeTruthy();
    const latest=[...responses].reverse().find(result=>result.query.instrument===row.id &&
      result.query.indicators[0].name===name && result.page.indicators[0]?.series[0]?.values?.filter(value=>value.value!==null).length>10);
    if(latest) {
      const values=latest.page.indicators[0].series[0].values.filter(value=>value.value!==null);
      const range={from:values[Math.max(0,values.length-100)].time/1000,to:values.at(-1).time/1000+60};
      await frame.evaluate(range=>widget.activeChart().setVisibleRange(range),range);
      await page.waitForTimeout(1000);
    }
    checks.push(`${row.series_kind} native ${name} full-origin output ready and study retained`);
    await page.screenshot({path:path.join(artifacts,`fixed-indicators-native-${row.series_kind}.png`),fullPage:true});
    const native=frame.childFrames().find(child=>child.url().includes('charting_library/'));
    if(native)expect(await native.locator('[role="dialog"]:visible').count()).toBe(0);
    await frame.evaluate(id=>widget.activeChart().removeEntity(id),study);
  }
  expect(responses.every(result=>result.status===200)).toBeTruthy();expect(errors).toEqual([]);
  const report={passed:true,environment:'Ubuntu market-watch-three-layer',checks,
    requests:responses.map(result=>({kind:result.query.series_kind,name:result.query.indicators[0].name,
      status:result.status,progress:result.page.indicator_progress}))};
  fs.writeFileSync(path.join(artifacts,'fixed-indicators-browser-real.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,checks}));
 } catch(error) {
  await page.screenshot({path:path.join(artifacts,'fixed-indicators-browser-failed.png'),fullPage:true});
  fs.writeFileSync(path.join(artifacts,'fixed-indicators-browser-failed.json'),JSON.stringify({error:String(error),errors,
    requests:responses.map(result=>({query:result.query,status:result.status,page:result.page}))},null,2));
  throw error;
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
