// Candidate source + real upstream + isolated local SQLite; never shared/production DB.
const {chromium}=require("@playwright/test");
const fs=require("node:fs"),assert=require("node:assert/strict");
const APP=process.env.APP_ORIGIN||"http://127.0.0.1:16100";
const CHART=process.env.CHART_ORIGIN||"http://127.0.0.1:16101";
(async()=> {
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});
  const errors=[],requests=[],pages=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("request",request=>{if(/\/api\/(?:charts|market-data)\//.test(request.url()))requests.push({url:request.url(),body:request.postDataJSON()})});
  page.on("response",async response=>{
    if(response.url().includes("/api/charts/data")) {
      const data=await response.json().catch(()=>({}));
      pages.push({status:response.status(),count:data.bars?.length,series_kind:data.series_kind,detail:data.detail});
    }
  });
  try {
    await page.goto(APP+"/");
    await page.getByLabel("管理员密码").fill(JSON.parse(fs.readFileSync("../../market-watch/artifacts/local-credentials.json")).password);
    await page.getByRole("button",{name:"登录工作台"}).click();
    await page.waitForURL(APP+"/");
    await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
    await page.evaluate(async()=>{
      const {csrf}=await (await fetch('/api/session')).json();
      const response=await fetch('/api/advanced-charts/workspaces',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({name:'双系列平台验收'})});
      if(!response.ok)throw Error('isolated workspace create failed');
    });
    await page.goto(APP+"/advanced-charts");
    await page.waitForSelector("iframe");
    const frame=page.frames().find(frame=>frame.url().startsWith(CHART+"/"));
    assert.ok(frame);
    await frame.waitForFunction(()=>ready && widget.activeChart().dataReady(),null,{timeout:60000});
    assert.equal(await frame.evaluate(()=>widget.activeChart().symbol()),"MWP:XAUUSD");
    const metrics=[];
    await frame.evaluate(()=>widget.activeChart().setSymbol('MWP:OANDA:EUR_CHF',{doNotActivateChart:true}));
    for(const resolution of ["5","60","240","1D","1W","1M"]) {
      const started=Date.now();
      await frame.evaluate(resolution=>widget.activeChart().setResolution(resolution,{doNotActivateChart:true}),resolution);
      await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
      const observed=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),
        range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()}));
      assert.equal(observed.symbol,"MWP:OANDA:EUR_CHF");
      assert.equal(observed.resolution,resolution);
      assert.ok(observed.range?.from<observed.range?.to);
      metrics.push({resolution,elapsed_ms:Date.now()-started,...observed});
    }
    await frame.evaluate(async()=>{
      await widget.activeChart().createStudy('守望 Python SMA',false,false,{period:20});
    });
    await frame.waitForFunction(()=>[...subscriptions.values()].some(s=>decode(s.symbol).spec));
    await frame.waitForFunction(()=>pending.size===0,null,{timeout:60000});
    assert.ok(requests.some(r=>r.body?.series_kind==='provider' && r.body?.indicators?.length));
    await frame.evaluate(()=>widget.activeChart().setResolution('1D',{doNotActivateChart:true}));
    const beforeNavigation=pages.length;
    await frame.evaluate(()=>widget.activeChart().setVisibleRange({from:Date.parse('2020-01-01T00:00:00Z')/1000,to:Date.parse('2020-06-01T00:00:00Z')/1000}));
    await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
    const navigation=await frame.evaluate(()=>widget.activeChart().getVisibleRange());
    assert.ok(navigation.from<Date.parse('2020-02-01T00:00:00Z')/1000);
    assert.ok(pages.length>beforeNavigation,'historical navigation must fetch an older platform page');
    await frame.evaluate(()=>widget.setLayout('8'));
    await frame.waitForFunction(()=>widget.chartsCount()===8);
    const competingStart=Date.now();
    await frame.evaluate(()=>Promise.all(Array.from({length:8},async(_,i)=>{
      const chart=widget.chart(i),symbols=['MWP:EURUSD','MWP:XAUUSD','MWP:BTCUSDT','MWP:OANDA:EUR_CHF'];
      await chart.setSymbol(symbols[i%4],{doNotActivateChart:true});
      await chart.setResolution(['5','60','240','1D'][i%4],{doNotActivateChart:true});
    })));
    await frame.waitForFunction(()=>Array.from({length:8},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:60000});
    const eight=await frame.evaluate(()=>Array.from({length:8},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),range:widget.chart(i).getVisibleRange()})));
    assert.ok(eight.every(chart=>chart.symbol.startsWith('MWP:')&&chart.range?.from<chart.range?.to));
    eight.forEach((chart,i)=>{
      assert.equal(chart.symbol,['MWP:EURUSD','MWP:XAUUSD','MWP:BTCUSDT','MWP:OANDA:EUR_CHF'][i%4]);
      assert.equal(chart.resolution,['5','60','240','1D'][i%4]);
    });
    assert.ok(!requests.some(r=>/\/history(?:\/|$)|\/activity$/.test(r.url)),"platform panes must not plan managed history or renew M1 demand");
    assert.ok(pages.length && pages.every(p=>p.status===200 && p.series_kind==='provider'));
    assert.deepEqual(errors,[]);
    await page.screenshot({path:"/tmp/mw-provider-native.png",fullPage:true});
    const evidence={passed:true,metrics,navigation,eight,eight_elapsed_ms:Date.now()-competingStart,pages,errors,managed_requests:requests.filter(r=>/\/history(?:\/|$)|\/activity$/.test(r.url))};
    fs.writeFileSync('/tmp/mw-provider-browser.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence,null,2));
  } catch(error) {
    await page.screenshot({path:"/tmp/mw-provider-native-failure.png",fullPage:true}).catch(()=>{});
    fs.writeFileSync('/tmp/mw-provider-browser-failure.json',JSON.stringify({error:String(error),pages,errors},null,2));
    throw error;
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
