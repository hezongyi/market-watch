// Public native APIs + actual local Docker workers and upstream. Serial browser run.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP=process.env.APP_ORIGIN||'https://localhost:15453';
const CHART=process.env.CHART_ORIGIN||'https://127.0.0.1:15454';
const SYMBOL=process.env.MANAGED_SYMBOL||'OANDA:EUR_GBP';
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});
  const errors=[],requests=[],samples=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/\/api\/(?:charts|market-data)\//.test(r.url())) requests.push({url:r.url(),body:r.postDataJSON()});});
  let frame;
  async function api(path,body){
    return page.evaluate(async({path,body})=>{
      const {csrf}=await(await fetch('/api/session')).json();
      const result=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
      if(!result.ok) throw Error('Acceptance API '+result.status+' '+path);
      return result.json();
    },{path,body});
  }
  try{
    await page.goto(APP+'/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
    await page.getByRole('button',{name:'登录工作台'}).click();
    await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
    const workspace=await api('advanced-charts/workspaces',{name:'自建持续维护容器验收'});
    await page.goto(APP+'/advanced-charts');
    await page.frameLocator('iframe').locator('#chart').waitFor();
    frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
    await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:60000});
    await frame.evaluate(async symbol=>{
      const chart=widget.activeChart();
      await chart.setResolution('5',{doNotActivateChart:true});
      await chart.setSymbol(symbol,{doNotActivateChart:true});
    },SYMBOL);
    await page.getByRole('dialog',{name:/维护自建行情/}).waitFor();
    assert.equal((await api('market-data/history/plans')).some(p=>p.instrument===SYMBOL),false);
    await page.getByRole('button',{name:'暂不维护'}).click();
    assert.equal((await api('market-data/history/plans')).some(p=>p.instrument===SYMBOL),false);
    assert.equal(await frame.evaluate(()=>widget.activeChart().symbol()),SYMBOL);
    // The explicit entry is a native public toolbar button; open its host form.
    await frame.evaluate(()=>send({type:'maintenance-required',instrument:widget.activeChart().symbol()}));
    const dialog=page.getByRole('dialog',{name:/维护自建行情/});
    await dialog.getByLabel('历史补数起点').fill('2026-09-01');
    assert.equal(await dialog.locator('input').count(),1,'maintenance has only one start input');
    await dialog.getByRole('button',{name:'确认加入维护'}).click();
    await page.getByRole('dialog',{name:'历史任务'}).waitFor();
    const plans=await api('market-data/history/plans');
    const submitted=plans.find(p=>p.instrument===SYMBOL);
    assert.ok(submitted?.realtime_enabled);
    const fixedEnd=submitted.end, approvedStart=submitted.start;
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    const geometry=await frame.evaluate(()=>({plot_width:widget.activeChart().getTimeScale().width(),bar_spacing:widget.activeChart().getTimeScale().barSpacing()}));
    const began=Date.now();
    let dataset;
    while(Date.now()-began<180000){
      dataset=await api('market-data/dataset',{instrument:SYMBOL,timeframe:'M5',...geometry});
      samples.push({elapsed_ms:Date.now()-began,...dataset});
      if(dataset.ready)break;
      await page.waitForTimeout(2000);
    }
    assert.ok(dataset.ready,'three actual screens of M5 must publish while deep history continues');
    assert.equal(dataset.threshold,3*Math.ceil(geometry.plot_width/geometry.bar_spacing));
    assert.equal(dataset.initialized,false,'first opening must not wait for whole approved month');
    const before=await frame.evaluate(()=>({spacing:widget.activeChart().getTimeScale().barSpacing(),symbol:widget.activeChart().symbol()}));
    await frame.evaluate(()=>refreshManagedHistory());
    await frame.waitForFunction(()=>widget.activeChart().dataReady()&&firstHistory.has(widget.activeChart().symbol()+'|'+widget.activeChart().resolution()),null,{timeout:60000});
    const loaded=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()}));
    assert.equal(loaded.symbol,SYMBOL);assert.equal(loaded.resolution,'5');
    assert.equal(loaded.spacing,before.spacing);assert.ok(loaded.range.from<loaded.range.to);
    const sessionStart=await frame.evaluate(()=>managedSessions.get(widget.activeChart().symbol()+'|5').start);
    await api('market-data/history/plans/control',{instrument:SYMBOL,action:'cancel'});
    const cancelled=(await api('market-data/history/plans')).find(p=>p.instrument===SYMBOL);
    assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.realtime_enabled);
    assert.equal(cancelled.start,approvedStart);assert.equal(cancelled.end,fixedEnd);
    // Independent native drawing identities in the same workspace.
    const managedShape=await frame.evaluate(()=>widget.activeChart().createShape({price:0.94,time:widget.activeChart().getVisibleRange().to},{shape:'horizontal_line'}));
    assert.ok(managedShape);
    await frame.evaluate(symbol=>widget.activeChart().setSymbol('MWP:'+symbol,{doNotActivateChart:true}),SYMBOL);
    await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
    const providerShapes=await frame.evaluate(()=>widget.activeChart().getAllShapes());
    assert.ok(!providerShapes.some(s=>s.id===managedShape),'managed drawings must not appear in provider series');
    const providerShape=await frame.evaluate(()=>widget.activeChart().createShape({price:0.95,time:widget.activeChart().getVisibleRange().to},{shape:'horizontal_line'}));
    await frame.evaluate(symbol=>widget.activeChart().setSymbol(symbol,{doNotActivateChart:true}),SYMBOL);
    await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
    const managedShapes=await frame.evaluate(()=>widget.activeChart().getAllShapes());
    assert.ok(managedShapes.some(s=>s.id===managedShape));
    assert.ok(!managedShapes.some(s=>s.id===providerShape));
    assert.equal(await frame.evaluate(()=>managedSessions.get(widget.activeChart().symbol()+'|5').start),sessionStart,'background growth does not change session boundary');
    assert.ok(!requests.some(r=>/\/history(?:\/demand|\/cache)?$/.test(r.url)),'managed chart must not use legacy automatic history endpoints');
    assert.deepEqual(errors,[]);
    await page.screenshot({path:'/tmp/mw-managed-container.png',fullPage:true});
    const evidence={passed:true,workspace:workspace.id,geometry,submitted,cancelled,samples,loaded,drawings:{managedShape,providerShape,managedShapes,providerShapes},errors};
    fs.writeFileSync('/tmp/mw-managed-container.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence,null,2));
  }catch(error){
    await page.screenshot({path:'/tmp/mw-managed-container-failure.png',fullPage:true}).catch(()=>{});
    fs.writeFileSync('/tmp/mw-managed-container-failure.json',JSON.stringify({error:String(error),errors,samples,requests},null,2));
    throw error;
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
