// Real Ubuntu application/API/native library. No intercepted market responses.
// Require finite native crosshair samples as well as settings/persistence.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = process.env.MW_SUPERTREND_BASE || 'http://localhost:20187';
const chartOrigin = process.env.MW_SUPERTREND_CHART_ORIGIN || 'http://localhost:20188';
const ticker = process.env.MW_SUPERTREND_TICKER || 'MWP:EURUSD';
const resolution = process.env.MW_SUPERTREND_RESOLUTION || '1D';
const output = path.resolve(process.env.MW_SUPERTREND_OUTPUT || '../artifacts/supertrend');
const studyName = '守望 Python SUPERTREND_PINE_V1';
const poll = async (fn, ms=60000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {if (await fn()) return; await new Promise(r => setTimeout(r,250));}
  throw Error('Acceptance condition timed out');
};
(async () => {
  fs.mkdirSync(output,{recursive:true});
  const browser = await chromium.launch({headless:true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1600,height:950}});
  const errors=[], responses=[], checks=[];
  await page.addInitScript(()=>{globalThis.supertrendResets=[];addEventListener('message',e=>{if(e.data?.type==='market-event' && e.data.event?.type==='reset')supertrendResets.push({reason:e.data.event.reason,at:Date.now()});});});
  let screenshot;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',async response=>{try {
    if (response.url().endsWith('/api/charts/data') && response.request().method()==='POST') {
      const query=response.request().postDataJSON();
      if(query.indicators?.[0]?.name==='SUPERTREND_PINE_V1')
        responses.push({query,status:response.status(),result:await response.json()});
    }
    if (/\/api\/charts\/history-loads\/[^/]+\/result$/.test(response.url())) {
      const body=await response.json(), result=body.result || body;
      const indicator=result.indicators?.find(item=>item.name==='SUPERTREND_PINE_V1');
      if(indicator) responses.push({query:{indicators:[{name:indicator.name,params:indicator.params}]},
        status:response.status(),result});
    }
    if(response.url().endsWith('/api/charts/history-loads') && response.request().method()==='POST') {
      const query=response.request().postDataJSON().query;
      const body=await response.json();
      if(query?.indicators?.[0]?.name==='SUPERTREND_PINE_V1' && body.result)
        responses.push({query,status:response.status(),result:body.result});
    }
  } catch {} });
  const hostFrame = async () => {
    await poll(()=>page.frames().some(f=>f.url().startsWith(chartOrigin+'/?')));
    const host=page.frames().find(f=>f.url().startsWith(chartOrigin+'/?'));
    await host.waitForFunction(()=>typeof ready!=='undefined' && ready && !loading && widget.activeChart().dataReady(),null,{timeout:60000});
    return host;
  };
  try {
    await page.goto(base+'/advanced-charts');
    await page.getByLabel('管理员密码').fill(fs.readFileSync(
      process.env.MW_SUPERTREND_LOGIN_FILE || '/tmp/mw-supertrend-20261012/login-password','utf8').trim());
    const login=page.waitForResponse(r=>r.url().endsWith('/api/login'));
    await page.getByRole('button',{name:'登录工作台'}).click();
    assert.equal((await login).status(),200);
    const legacyCatalog=await(await page.request.get(base+'/api/charts/catalog')).json();
    assert.deepEqual(Object.keys(legacyCatalog.indicators).sort(),
      ['SMA','EMA','LWMA','BBANDS','RSI','MACD','ATR','STOCH'].sort());
    const legacy=await page.evaluate(async()=>{
      const session=await(await fetch('/api/session')).json();
      const response=await fetch('/api/charts/workspaces',{method:'POST',
        headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
        body:JSON.stringify({name:'Supertrend legacy catalog regression'})});
      if(!response.ok) throw Error('Legacy workspace creation failed '+response.status);
      return response.json();
    });
    await page.goto(base+'/chart-workspaces/'+legacy.id);
    await page.getByRole('button',{name:'指标',exact:true}).click();
    const picker=page.getByLabel('新增指标类型');
    assert.deepEqual(await picker.locator('option').evaluateAll(items=>items.map(i=>i.value).sort()),
      Object.keys(legacyCatalog.indicators).sort());
    await picker.selectOption('SMA');
    await page.getByRole('button',{name:'添加指标',exact:true}).click();
    const period=page.getByRole('dialog').locator('fieldset').first().locator('input[type=number]');
    await period.fill('11');await period.press('Tab');
    assert.equal(await period.inputValue(),'11');
    await page.screenshot({path:path.join(output,'legacy-catalog.png')});
    await page.getByRole('button',{name:'关闭设置'}).click();
    await page.getByRole('button',{name:'保存',exact:true}).click();
    await poll(async()=>{
      const saved=await(await page.request.get(base+'/api/charts/workspaces')).json();
      return saved.find(row=>row.id===legacy.id)?.document.panels[0].indicators[0]?.params.period===11;
    });
    checks.push('legacy workspace lists only eight supported studies; SMA period edit saves to server');
    await page.goto(base+'/advanced-charts');
    await page.evaluate(async ticker=>{
      const session=await(await fetch('/api/session')).json();
      const response=await fetch('/api/advanced-charts/workspaces',{method:'POST',
        headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
        body:JSON.stringify({name:'Supertrend Ubuntu acceptance',symbol:'MWP:EURUSD'})});
      if(!response.ok) throw Error('Workspace creation failed '+response.status);
    },ticker);
    await page.goto(base+'/advanced-charts');
    let host=await hostFrame();
    const catalog=await(await page.request.get(base+'/api/advanced-charts/catalog')).json();
    assert.equal(catalog.SUPERTREND_PINE_V1.source,'Python');
    await host.evaluate(async ({ticker,resolution})=>{
      await widget.activeChart().setSymbol(ticker);
      await widget.activeChart().setResolution(resolution);
      await widget.changeTheme('Dark');
    },{ticker,resolution});
    await host.waitForFunction(()=>widget.activeChart().dataReady() && pending.size===0 && requests.length===0,null,{timeout:90000});
    const ids=await host.evaluate(async name=>[
      await widget.activeChart().createStudy(name,false,false),
      await widget.activeChart().createStudy(name,false,false,{period:7,source:'ohlc4',multiplier:2,changeATR:false}),
    ],studyName);
    assert.ok(ids.every(Boolean));
    console.log('Two native Supertrend studies created');
    await page.screenshot({path:path.join(output,'created.png')});
    await poll(()=>responses.some(r=>r.status===200 && r.query.indicators[0].params.period===10 &&
      r.result.indicators?.[0]?.series.some(s=>s.key==='up'&&s.values.some(v=>v.value!==null))),120000);
    checks.push('Python catalog; two native instances; real backend output received');
    const rendered = async (host, ids, titles=['up','down','Up Trend','Down Trend']) => {
      await host.evaluate(()=>{
        globalThis.supertrendSamples=[];
        widget.activeChart().crossHairMoved().subscribe(null,s=>supertrendSamples.push(s));
      });
      const ui=host.childFrames()[0];
      const box=await ui.locator('.chart-container').first().boundingBox();
      await poll(async()=>{
        if (!await host.evaluate(()=>widget.activeChart().dataReady() && pending.size===0 && requests.length===0)) return false;
        await host.evaluate(()=>{supertrendSamples=[];});
        for(let i=0;i<12;i++) {
          await page.mouse.move(box.x+box.width*(0.2+i*0.055),box.y+180);
          await page.waitForTimeout(30);
        }
        return host.evaluate(({ids,titles})=>ids.every(id=>new Set(supertrendSamples.filter(s=>
          s.entityValues?.[id]?.values.some(v=>(!titles.length || titles.includes(v.title)) &&
          typeof v.value==='string' && Number.isFinite(Number(v.value.replace(/,/g,''))))).map(s=>s.time)).size>=5),{ids,titles});
      },90000);
      await host.waitForFunction(()=>widget.activeChart().dataReady() && pending.size===0 && requests.length===0,null,{timeout:90000});
      await page.waitForTimeout(1200);
      await page.mouse.move(1550,20);
    };
    await rendered(host,ids);
    const swingName='守望 Python SWING_SR_V1';
    const swingId=await host.evaluate(name=>widget.activeChart().createStudy(name,false,false,
      {high_strength:3,low_strength:7}),swingName);
    assert.ok(swingId);
    await rendered(host,[...ids,swingId],[]);
    await host.evaluate(id=>widget.activeChart().getStudyById(id).setInputValues([
      {id:'show_average_spacing',value:false},{id:'statistics_position',value:'bottom_left'}]),swingId);
    await page.screenshot({path:path.join(output,'swing-coexistence.png')});
    checks.push('Supertrend and Swing coexist with finite native values and independent settings');
    checks.push('each native study exposes finite plotted trend values on five distinct candles');
    const style=await host.evaluate(id=>widget.activeChart().getStudyById(id).getStyleValues(),ids[0]);
    assert.equal(style.styles.up.plottype,7);
    assert.equal(style.styles.down.plottype,7);
    assert.equal(style.styles.buy_dot.location,'Absolute');
    const ui=host.childFrames()[0];
    await host.evaluate(id=>widget.activeChart().showPropertiesDialog(id),ids[0]);
    await ui.getByText('ATR Period',{exact:true}).waitFor();
    assert.ok(await ui.locator('input[type=checkbox]').count()>=3);
    screenshot=path.join(output,'settings.png'); await page.screenshot({path:screenshot});
    await page.keyboard.press('Escape');
    await host.evaluate(id=>widget.activeChart().getStudyById(id).setInputValues([
      {id:'showsignals',value:false},{id:'highlighting',value:false}]),ids[0]);
    await host.evaluate(id=>widget.activeChart().getStudyById(id).applyOverrides({'Up Trend.color':'#9c27b0','Down Trend.linewidth':3}),ids[1]);
    const changedStyle=await host.evaluate(id=>widget.activeChart().getStudyById(id).getStyleValues(),ids[1]);
    assert.equal(changedStyle.styles.up.color,'#9c27b0');
    assert.equal(changedStyle.styles.down.linewidth,3);
    await host.evaluate(id=>widget.activeChart().getStudyById(id).setVisible(false),ids[1]);
    await rendered(host,[ids[0]]);
    await page.screenshot({path:path.join(output,'switches-off.png')});
    await host.evaluate(id=>widget.activeChart().getStudyById(id).setVisible(true),ids[1]);
    await poll(()=>host.evaluate(id=>widget.activeChart().getStudyById(id).getInputValues()
      .filter(v=>['showsignals','highlighting'].includes(v.id)).every(v=>v.value===false),ids[0]));
    const template=await host.evaluate(()=>widget.activeChart().createStudyTemplate({saveSymbol:true,saveInterval:true}));
    await host.evaluate(template=>widget.activeChart().applyStudyTemplate(template),template);
    await poll(()=>host.evaluate(name=>widget.activeChart().getAllStudies().filter(s=>s.name===name).length===2,studyName));
    const values=await host.evaluate(name=>widget.activeChart().getAllStudies().filter(s=>s.name===name)
      .map(s=>widget.activeChart().getStudyById(s.id).getInputValues()),studyName);
    assert.ok(values.some(inputs=>inputs.find(i=>i.id==='showsignals')?.value===false));
    assert.ok(values.some(inputs=>inputs.find(i=>i.id==='source')?.value==='ohlc4'));
    const templatedSwing=await host.evaluate(name=>{
      const study=widget.activeChart().getAllStudies().find(s=>s.name===name);
      return study && widget.activeChart().getStudyById(study.id).getInputValues();
    },swingName);
    assert.equal(templatedSwing.find(i=>i.id==='high_strength').value,3);
    assert.equal(templatedSwing.find(i=>i.id==='show_average_spacing').value,false);
    checks.push('native Boolean controls; display inputs; study template preserves two independent instances');
    const templatedIds=await host.evaluate(name=>widget.activeChart().getAllStudies().filter(s=>s.name===name).map(s=>s.id),studyName);
    await rendered(host,templatedIds);
    await host.waitForFunction(()=>!loading && widget.activeChart().dataReady(),null,{timeout:60000});
    await host.evaluate(()=>new Promise((ok,bad)=>widget.saveChartToServer(ok,bad)));
    await page.reload();host=await hostFrame();
    await poll(()=>host.evaluate(name=>widget.activeChart().getAllStudies().filter(s=>s.name===name).length===2,studyName));
    checks.push('actual workspace server save/reload restores stable study identities');
    const restored=await host.evaluate(name=>widget.activeChart().getAllStudies().filter(s=>s.name===name)
      .map(s=>({id:s.id,inputs:widget.activeChart().getStudyById(s.id).getInputValues()})),studyName);
    const original=restored.find(s=>s.inputs.find(i=>i.id==='period')?.value===10);
    const alternate=restored.find(s=>s.inputs.find(i=>i.id==='period')?.value===7);
    assert.ok(original && alternate);
    assert.equal(original.inputs.find(i=>i.id==='showsignals').value,false);
    assert.equal(original.inputs.find(i=>i.id==='highlighting').value,false);
    assert.equal(alternate.inputs.find(i=>i.id==='source').value,'ohlc4');
    assert.equal(alternate.inputs.find(i=>i.id==='changeATR').value,false);
    const alternateStyle=await host.evaluate(id=>widget.activeChart().getStudyById(id).getStyleValues(),alternate.id);
    assert.equal(alternateStyle.styles.up.color,'#9c27b0');
    assert.equal(alternateStyle.styles.down.linewidth,3);
    checks.push('server reload preserves both calculation/display inputs and custom color/line width');
    await rendered(host,[original.id,alternate.id]);
    const restoredSwing=await host.evaluate(name=>{
      const study=widget.activeChart().getAllStudies().find(s=>s.name===name);
      return study && {id:study.id,inputs:widget.activeChart().getStudyById(study.id).getInputValues()};
    },swingName);
    assert.ok(restoredSwing);
    assert.equal(restoredSwing.inputs.find(i=>i.id==='high_strength').value,3);
    assert.equal(restoredSwing.inputs.find(i=>i.id==='low_strength').value,7);
    assert.equal(restoredSwing.inputs.find(i=>i.id==='show_average_spacing').value,false);
    assert.equal(restoredSwing.inputs.find(i=>i.id==='statistics_position').value,'bottom_left');
    await rendered(host,[original.id,alternate.id,restoredSwing.id],[]);
    await page.screenshot({path:path.join(output,'swing-restored.png')});
    checks.push('study template and server reload preserve Swing alongside both Supertrend instances');
    await host.evaluate(id=>widget.activeChart().removeEntity(id),restoredSwing.id);
    await host.evaluate(id=>widget.activeChart().removeEntity(id),alternate.id);
    await host.evaluate(async id=>{await widget.activeChart().getStudyById(id).setInputValues([
      {id:'showsignals',value:true},{id:'highlighting',value:true}]);},original.id);
    await rendered(host,[original.id]);
    assert.ok((await host.evaluate(id=>widget.activeChart().getStudyById(id).getInputValues(),original.id)).filter(i=>['showsignals','highlighting'].includes(i.id)).every(i=>i.value===true));
    if (ticker==='MWP:EURUSD' && resolution==='1D') {
      await host.evaluate(async()=>{
        (await widget.widgetbar()).changeWidgetBarVisibility(false);
        await widget.activeChart().setVisibleRange({from:Date.parse('2025-11-15T00:00:00Z')/1000,to:Date.parse('2027-01-01T00:00:00Z')/1000});
      });
      await rendered(host,[original.id]);
    }
    screenshot=path.join(output,'native-dark.png');await page.screenshot({path:screenshot});
    await host.evaluate(()=>widget.changeTheme('Light'));await rendered(host,[original.id]);
    await page.screenshot({path:path.join(output,'native-light.png')});
    await host.evaluate(()=>widget.changeTheme('Dark'));
    await rendered(host,[original.id]);
    await host.evaluate(()=>new Promise((ok,bad)=>widget.saveChartToServer(ok,bad)));
    if (process.env.MW_SUPERTREND_REGRESSION==='1') {
      const regressions=await host.evaluate(async()=>{
        const ids=[];
        for(const name of ['SMA','EMA','LWMA','BBANDS','RSI','MACD','ATR','STOCH'])
          ids.push(await widget.activeChart().createStudy('守望 Python '+name,false,false));
        ids.push(await widget.activeChart().createStudy('SuperTrend',false,false));
        return ids;
      });
      await rendered(host,regressions,[]);
      checks.push('all eight existing Python indicators and built-in SuperTrend expose native finite values');
    }
    const resets=await host.evaluate(()=>supertrendResets);
    assert.ok(!resets.some(e=>e.reason==='delivery_budget'),'plot subscriptions must not overflow push delivery');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify({passed:true,environment:'Ubuntu Docker mw-supertrend-20261012',
      base,chartOrigin,ticker,checks,errors,resets,
      visual_review:'Screenshots require inspection for labels, dot anchoring, fills, gaps and reference plot.',
      requests:responses.map(r=>({query:r.query,status:r.status,calculation:r.result.indicator_progress}))},null,2));
    console.log(JSON.stringify({passed:true,checks}));
  } catch(error) {
    console.log('Failed diagnostic',await page.frames().find(f=>f.url().startsWith(chartOrigin+'/?'))?.evaluate(()=>({resets:supertrendResets,pending:pending.size,queue:requests.map(v=>v.query),subscriptions:[...subscriptions.values()].map(s=>({symbol:s.symbol,last:s.last,needsHistoryReload:s.needsHistoryReload}))})).catch(()=>({})));
    await page.screenshot({path:path.join(output,'browser-failed.png')}).catch(()=>{});
    fs.writeFileSync(path.join(output,'browser-failed.json'),JSON.stringify({error:String(error),checks,errors},null,2));
    throw error;
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
