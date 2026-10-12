// Real task-local Docker app, PostgreSQL preferences/workspaces, and shared SSE.
// Run only after the dedicated Compose stack has been built, started and seeded.
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const PRIVATE = '/tmp/mw-swing-sr-20261012-private';
const APP = 'https://localhost:16443', CHART = 'https://127.0.0.1:16444';
const COMPOSE = ['compose', '-p', 'mw-swing-sr-20261012', '-f', 'deploy/ubuntu/compose.swing-sr.yaml'];
function tick(action) {
  execFileSync('docker', [...COMPOSE, 'exec', '-T', 'api', 'python', '/acceptance/tick.py', action], {
    cwd: ROOT, env: { ...process.env, MW_SWING_PRIVATE_DIR: PRIVATE }, stdio: 'pipe',
  });
}
function sharedTasks(client) {
  const code=`import json
from alerts.storage import transaction, MarketStreamTask, MarketStreamSubscription, MarketStreamClient, now_ms
from sqlalchemy import select, func
with transaction() as db:
 rows=[]
 for task in db.scalars(select(MarketStreamTask).where(MarketStreamTask.expires>now_ms())):
  if any(s.get('name')=='SWING_SR_V1' for s in task.query.get('indicators',[])):
   rows.append({'task':task.id,'params':task.query['indicators'][0]['params'],'sequence':task.sequence,'listeners':db.scalar(select(func.count()).select_from(MarketStreamSubscription).join(MarketStreamClient,MarketStreamClient.id==MarketStreamSubscription.client_id).where(MarketStreamSubscription.task_id==task.id,MarketStreamSubscription.active.is_(True),MarketStreamClient.client==${JSON.stringify(client)}))})
 print(json.dumps(rows))`;
  return JSON.parse(execFileSync('docker', [...COMPOSE, 'exec', '-T', 'api', 'python', '-c', code], {
    cwd: ROOT, env: { ...process.env, MW_SWING_PRIVATE_DIR: PRIVATE }, encoding:'utf8',
  }));
}
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1900, height: 950 } });
  const errors = [], requests = [];
  const validations = [];
  let changedFixture = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/api/charts/data') && request.method() === 'POST') {
      const query = request.postDataJSON();
      if (query.indicators?.some(spec => spec.name === 'SWING_SR_V1')) requests.push(query);
    }
  });
  async function api(endpoint, body) {
    return page.evaluate(async ({ endpoint, body }) => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch('/api/' + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw Error(endpoint + ': ' + response.status);
      return response.json();
    }, { endpoint, body });
  }
  async function frame() {
    await page.locator('iframe[title="专业图表工作区"]').waitFor({ timeout: 30000 });
    await page.frameLocator('iframe[title="专业图表工作区"]').locator('#chart').waitFor({ timeout: 30000 });
    const chart = page.frames().find(item => item.url().startsWith(CHART + '/'));
    assert.ok(chart, 'task-local chart origin must load');
    await chart.waitForFunction(() => typeof ready!=='undefined' && ready && !loading && widget.activeChart().dataReady(), null,
      { timeout: 60000 });
    return chart;
  }
  async function createWorkspace(name) {
    const row = await api('advanced-charts/workspaces', { name });
    return api('advanced-charts/workspaces/' + row.id + '/save', {
      name, revision: row.revision,
      document: { ...row.document, symbol: 'EURUSD', series_kind: 'managed', interval: '240' },
    });
  }
  async function save(chart) {
    await chart.waitForFunction(() => !loading && !nativeSaving && !rangeGuard?.busy() && !edgeGuard?.busy() &&
      Array.from({length:widget.chartsCount()},(_,index)=>widget.chart(index).dataReady()).every(Boolean));
    await chart.evaluate(() => new Promise((resolve, reject) => {
      const deadline=setTimeout(()=>reject(Error('Native save callback timed out')),20000);
      widget.saveChartToServer(()=>{clearTimeout(deadline);resolve();},error=>{clearTimeout(deadline);
        reject(Error(typeof error==='string'?error:JSON.stringify(error)));});
    }));
  }
  async function inputs(chart) {
    return chart.evaluate(() => widget.activeChart().getAllStudies().map(item => ({
      name: item.name, inputs: widget.activeChart().getStudyById(item.id).getInputValues(),
      styles: widget.activeChart().getStudyById(item.id).getStyleValues(),
      visible: widget.activeChart().getStudyById(item.id).isVisible(),
    })));
  }
  try {
    await page.goto(APP + '/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(PRIVATE + '/credentials.json')).password);
    await page.getByRole('button', { name: '登录工作台' }).click();
    await page.waitForFunction(() => !document.querySelector('input[type="password"]'));
    const workspace = await createWorkspace('Swing Docker 验收 ' + Date.now());
    const spec = { name: 'SWING_SR_V1' };
    const numerical = await api('charts/data', {
      instrument: 'EURUSD', series_kind: 'managed', timeframe: 'H4', published: true,
      limit: 175, indicators: [spec], provisional: true,
    });
    const presentation = numerical.indicators[0].presentation;
    const earliest = await api('charts/data', {
      instrument: 'EURUSD', series_kind: 'managed', timeframe: 'H4', published: true,
      before: numerical.origin + 1, limit: 175, indicators: [spec], provisional: true,
    });
    assert.equal(earliest.bars.length,1);
    assert.equal(earliest.bars[0].start,numerical.origin);
    assert.equal(earliest.has_more,false,'the published origin must terminate Swing pagination');
    assert.deepEqual(earliest.indicators[0].presentation,presentation,
      'the earliest viewport still uses the full current statistics');
    validations.push('published Swing origin ends pagination while preserving full statistics');
    for (const [side, count, sum, intervals, integer] of [
      ['high', 264, 3989, 263, 15], ['low', 249, 3978, 248, 16],
    ]) {
      const stats = presentation.statistics[side];
      assert.deepEqual([stats.event_count, stats.interval_sum, stats.interval_count, stats.display_integer],
        [count, sum, intervals, integer]);
      assert.ok(Math.abs(stats.mean - sum / intervals) < 1e-12);
    }
    await page.goto(APP + '/advanced-charts');
    let chart = await frame();
    const initialUI=chart.childFrames()[0];
    await initialUI.getByRole('button',{name:'指标',exact:true}).click();
    await initialUI.getByRole('button',{name:'我的 Python',exact:true}).click();
    const pythonRows=initialUI.locator('.mw-native-study-row');
    assert.equal(await pythonRows.count(),9,'eight existing Python indicators plus Swing');
    const swingRow=initialUI.locator('.mw-native-study-row[data-native-study-id="MWPythonSWING_SR_V1@market-watch"]');
    await swingRow.waitFor();
    assert.ok((await swingRow.innerText()).includes('Python SWING_SR_V1'));
    await swingRow.locator('[role="option"]').click();
    await initialUI.getByRole('button',{name:'关闭指标窗口',exact:true}).click();
    validations.push('native Python catalog lists nine identities and adds Swing through real UI');
    await chart.waitForFunction(() => document.querySelector('.mw-swing-row')?.textContent.includes('高点 15根'));
    await chart.waitForFunction(() => widget.activeChart().getAllShapes().length === 2);
    const historyBoundary=await chart.evaluate(async()=>{
      const ticker=[...subscriptions.values()].find(sub=>decode(sub.symbol).spec?.name==='SWING_SR_V1').symbol;
      const result=await new Promise((resolve,reject)=>feed.getBars({ticker},'240',
        {to:Math.floor(Date.now()/1000),countBack:5000,firstDataRequest:false},
        (bars,meta)=>resolve({count:bars.length,first:bars[0]?.time,last:bars.at(-1)?.time,meta}),reject));
      return result;
    });
    assert.equal(historyBoundary.count,4002);
    assert.equal(historyBoundary.first,numerical.origin);
    assert.equal(historyBoundary.meta.noData,true,'native datafeed must stop after the published origin');
    validations.push('actual native Swing datafeed traverses 4002 bars and terminates an oversized countBack');
    const staleSnapshot=await chart.evaluate(async()=>{
      const live=[...subscriptions.values()].find(sub=>decode(sub.symbol).spec?.name==='SWING_SR_V1');
      const identity=decode(live.symbol),symbol=MWSeries.encode(identity.symbol,identity.series_kind);
      const previous=swingStore().get(symbol,live.res,identity.spec.params);
      const acceptedRevision=previous.presentation.history_revision;
      const staleRevision=(BigInt(acceptedRevision)-1n).toString();
      const probe='swing-revision-acceptance-'+crypto.randomUUID();
      let callbacks=0;
      subscriptions.set(probe,{...live,marketListener:probe,marketSequence:0,cb:()=>{callbacks++;}});
      const bar=previous.bars.at(-1);
      try {
        dispatchEvent(new MessageEvent('message',{source:parent,origin:parentOrigin,
          data:{channel:'mw-chart-v1',type:'market-event',event:{type:'bars',listener:probe,
            generation:live.marketGeneration,sequence:1,bars:[bar],
            indicators:[{name:'SWING_SR_V1',params:identity.spec.params,
              presentation:{...previous.presentation,history_revision:staleRevision},
              series:['high','high_left','low','low_left'].map(key=>({key,
                values:[{time:bar.chart_time ?? bar.start,value:999}]}))}]}}}));
        await new Promise(resolve=>setTimeout(resolve,0));
        const current=swingStore().get(symbol,live.res,identity.spec.params);
        return {acceptedRevision,staleRevision,currentRevision:current.presentation.history_revision,
          unchanged:current===previous,callbacks};
      } finally {subscriptions.delete(probe);}
    });
    assert.equal(staleSnapshot.unchanged,true,'the rendered display must retain its accepted snapshot');
    assert.equal(staleSnapshot.callbacks,0,'a stale replay cannot reach native plots');
    validations.push('real browser message handler rejects older revision for both display and native plots');
    await page.screenshot({path:path.join(ROOT,'artifacts/swing-review-blockers.png')});
    const firstShared=sharedTasks(await chart.evaluate(()=>clientId));
    assert.ok(firstShared.some(task=>task.params.high_strength===5 && task.params.low_strength===5 && task.listeners===4),
      'four native plot subscriptions must share one durable calculation task');
    const defaultStyles=await inputs(chart);
    assert.ok(Object.values(defaultStyles[0].styles.styles).every(style=>style.plottype===6));
    const geometry=await chart.evaluate(()=>({
      range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing(),
      shapes:widget.activeChart().getAllShapes().map(shape=>({id:shape.id,
        points:widget.activeChart().getShapeById(shape.id).getPoints(),
        properties:widget.activeChart().getShapeById(shape.id).getProperties()})),
    }));
    assert.ok(geometry.shapes.every(shape=>shape.points.length===2 && shape.points[0].price===shape.points[1].price));
    await chart.evaluate(range => widget.activeChart().setVisibleRange(range), {
      from: numerical.bars.at(-100).start / 1000, to: numerical.bars.at(-1).start / 1000,
    });
    await chart.evaluate(() => widget.activeChart().getTimeScale().setBarSpacing(13));
    await chart.waitForFunction(() => Math.abs(widget.activeChart().getTimeScale().barSpacing()-13)<.01);
    await chart.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(ROOT, 'artifacts/swing-application-dark.png') });
    await page.setViewportSize({width:1600,height:950});
    await chart.evaluate(async()=>{
      (await widget.widgetbar()).changeWidgetBarVisibility(false);
      const scale=widget.activeChart().getTimeScale();scale.setBarSpacing(13);scale.setRightOffset(12);
    });
    await chart.waitForFunction(()=>Math.abs(widget.activeChart().getTimeScale().barSpacing()-13)<.01);
    await chart.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const screenshotGeometry=await chart.evaluate(()=>({range:widget.activeChart().getVisibleRange(),
      spacing:widget.activeChart().getTimeScale().barSpacing(),pane:swingPaneBounds(widget.activeChart(),document.getElementById('chart'))}));
    await page.screenshot({path:path.join(ROOT,'artifacts/swing-application-comparison.png')});
    await page.setViewportSize({width:1900,height:950});
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('four circles and finite horizontal bridges');
    changedFixture = true;
    tick('withdraw');
    await chart.waitForFunction(() => widget.activeChart().getAllShapes().some(item =>
      widget.activeChart().getShapeById(item.id).getPoints()[0].price === 1.1276), null, { timeout: 30000 });
    tick('restore');
    await chart.waitForFunction(() => widget.activeChart().getAllShapes().some(item =>
      widget.activeChart().getShapeById(item.id).getPoints()[0].price === 1.1242), null, { timeout: 30000 });
    tick('confirm');
    await chart.waitForFunction(() => document.querySelector('.mw-swing-details')?.textContent.includes('高点 264（预览 0）'),
      null, { timeout: 30000 });
    tick('restore');
    await chart.waitForFunction(() => document.querySelector('.mw-swing-details')?.textContent.includes('高点 263（预览 1）'),
      null, { timeout: 30000 });
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('actual shared SSE withdrawal, restore and confirmation');
    await chart.evaluate(() => {
      const c = widget.activeChart();
      c.getStudyById(c.getAllStudies()[0].id).setInputValues([
        { id: 'high_strength', value: 3 }, { id: 'low_strength', value: 7 },
        { id: 'statistics_position', value: 'bottom_left' }, { id: 'show_average_spacing', value: false },
      ]);
      c.getStudyById(c.getAllStudies()[0].id).applyOverrides({
        'high.color': '#ff9800', 'high.linewidth': 3,
        'high_left.color': '#ff9800', 'high_left.linewidth': 4,
        'low_left.visible': false,
      });
    });
    await chart.waitForFunction(() => !document.querySelector('.mw-swing-row'));
    const expected = await inputs(chart);
    assert.equal(expected[0].styles.styles.plot0.color, '#ff9800');
    assert.equal(expected[0].styles.styles.plot1.linewidth, 4);
    assert.equal(expected[0].styles.styles.plot3.visible, false);
    const bridgeIds = await chart.evaluate(() => widget.activeChart().getAllShapes().map(item => item.id));
    await save(chart);
    const storedWorkspace = await api('advanced-charts/native-charts/' + workspace.id);
    for (const id of bridgeIds) assert.ok(!storedWorkspace.content.includes(id), 'derived bridges must not persist');
    const ui = chart.childFrames()[0], templateName = 'Swing 持久模板 ' + Date.now();
    await ui.getByRole('button', { name: '保存或应用指标模板', exact: true }).click();
    await ui.getByText('保存指标模板', { exact: true }).filter({ visible: true }).click();
    await ui.locator('input[maxlength="64"]').fill(templateName);
    await ui.locator('input[maxlength="64"]').press('Enter');
    await page.waitForFunction(async name => (await (await fetch('/api/advanced-charts/preferences')).json())
      .some(row => row.kind === 'study' && row.name === name), templateName);
    const template = (await api('advanced-charts/preferences')).find(row => row.name === templateName);
    assert.equal(typeof template.content.value, 'string');
    await page.reload();
    chart = await frame();
    assert.deepEqual(await inputs(chart), expected, 'workspace must restore both strengths and hidden card position');
    await chart.evaluate(() => {
      const c = widget.activeChart();
      c.getStudyById(c.getAllStudies()[0].id).setInputValues([{ id: 'show_average_spacing', value: true }]);
    });
    await chart.waitForFunction(() => document.querySelector('.mw-swing-card'));
    await createWorkspace('Swing 跨工作区模板 ' + Date.now());
    await page.reload();
    chart = await frame();
    const secondUI = chart.childFrames()[0];
    await secondUI.getByRole('button', { name: '保存或应用指标模板', exact: true }).click();
    await secondUI.getByText(templateName, { exact: true }).click();
    await chart.waitForFunction(() => widget.activeChart().getAllStudies().length === 1);
    assert.deepEqual(await inputs(chart), expected, 'preferences API template must restore inputs in another workspace');
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('workspace and preferences template restore strengths, display settings and styles');
    assert.equal(await chart.locator('.mw-swing-row').count(), 0);
    await chart.evaluate(() => {
      const c = widget.activeChart();
      c.getStudyById(c.getAllStudies()[0].id).setInputValues([{ id: 'show_average_spacing', value: true }]);
      widget.setLayout('2h');
    });
    await chart.waitForFunction(() => widget.chartsCount() === 2);
    await chart.evaluate(async () => {
      const c = widget.chart(1);
      for(const study of c.getAllStudies()) c.removeEntity(study.id);
      await c.setSymbol('EURUSD', { doNotActivateChart: true });
      await c.setResolution('240', { doNotActivateChart: true });
      await c.createStudy('守望 Python SWING_SR_V1', false, false);
    });
    await chart.waitForFunction(() => document.querySelectorAll('.mw-swing-row').length === 2 &&
      widget.chart(0).getAllStudies().length===1 && widget.chart(1).getAllStudies().length===1 &&
      widget.chart(0).getAllShapes().length === 2 && widget.chart(1).getAllShapes().length === 2);
    await save(chart);
    const multi = await inputs(chart);
    await page.reload();
    chart = await frame();
    await chart.waitForFunction(() => widget.chartsCount() === 2 && document.querySelectorAll('.mw-swing-row').length === 2);
    assert.deepEqual(await inputs(chart), multi);
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('two charts save/reload');
    await chart.evaluate(()=>widget.chart(1).getStudyById(widget.chart(1).getAllStudies()[0].id).setInputValues([
      {id:'high_strength',value:3},{id:'low_strength',value:7}]));
    await chart.waitForFunction(()=>Array.from(document.querySelectorAll('.mw-swing-row')).every(row=>row.textContent.includes('Swing 3 7')));
    let multiShared=[];
    // Native parameter reload and its old subscription teardown are async.
    for(let attempt=0;attempt<120;attempt++) {
      multiShared=sharedTasks(await chart.evaluate(()=>clientId));
      if(multiShared.filter(task=>task.listeners>0).length===1 && multiShared.some(task=>task.params.high_strength===3 && task.params.low_strength===7 && task.listeners===4)) break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(multiShared.filter(task=>task.listeners>0).length,1,
      'same-strength charts use one server task: '+JSON.stringify(multiShared));
    assert.ok(multiShared.some(task=>task.params.high_strength===3 && task.params.low_strength===7 && task.listeners===4),
      'the native library shares four synthetic subscriptions across two charts: '+JSON.stringify(multiShared));
    tick('withdraw');
    const withdrawn=await api('charts/data',{instrument:'EURUSD',series_kind:'managed',timeframe:'H4',published:true,
      limit:175,indicators:[{name:'SWING_SR_V1',params:{high_strength:3,low_strength:7}}],provisional:true});
    const price=withdrawn.indicators[0].presentation.current.high.price;
    await chart.waitForFunction(price=>[0,1].every(index=>widget.chart(index).getAllShapes().some(shape=>
      widget.chart(index).getShapeById(shape.id).getPoints()[0].price===price)),price,{timeout:30000});
    tick('restore');
    await chart.waitForFunction(()=>[0,1].every(index=>widget.chart(index).getAllShapes().some(shape=>
      widget.chart(index).getShapeById(shape.id).getPoints()[0].price===1.1242)),null,{timeout:30000});
    await save(chart);
    await chart.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(ROOT, 'artifacts/swing-application-two-charts.png') });
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('two same-strength charts share four native subscriptions and one server task; both receive withdrawal and restoration');
    await chart.evaluate(()=>widget.setLayout('s'));
    await chart.waitForFunction(()=>widget.chartsCount()===1);
    await chart.evaluate(()=>widget.activeChart().getStudyById(widget.activeChart().getAllStudies()[0].id).setVisible(false));
    await chart.waitForFunction(()=>!document.querySelector('.mw-swing-row') && widget.activeChart().getAllShapes().length===0);
    await chart.evaluate(()=>widget.activeChart().getStudyById(widget.activeChart().getAllStudies()[0].id).setVisible(true));
    await chart.waitForFunction(()=>document.querySelector('.mw-swing-card') && widget.activeChart().getAllShapes().length===2);
    await chart.evaluate(()=>widget.activeChart().setResolution('60',{doNotActivateChart:true}));
    await chart.waitForFunction(()=>!document.querySelector('.mw-swing-row') && widget.activeChart().getAllShapes().length===0);
    await chart.evaluate(()=>widget.activeChart().setResolution('240',{doNotActivateChart:true}));
    await chart.waitForFunction(()=>document.querySelector('.mw-swing-card') && widget.activeChart().getAllShapes().length===2);
    await chart.evaluate(()=>widget.activeChart().setSymbol('XAUUSD',{doNotActivateChart:true}));
    await chart.waitForFunction(()=>!document.querySelector('.mw-swing-row') && widget.activeChart().getAllShapes().length===0);
    await chart.evaluate(()=>widget.activeChart().setSymbol('EURUSD',{doNotActivateChart:true}));
    await chart.waitForFunction(()=>document.querySelector('.mw-swing-card') && widget.activeChart().getAllShapes().length===2);
    // Empty acceptance symbols/periods correctly report missing history. Clear
    // these native notices before capturing the restored populated chart.
    for(let attempt=0;attempt<5 && await chart.evaluate(()=>noticeDialogOpen);attempt++) {
      await chart.childFrames()[0].getByRole('button',{name:'确认',exact:true}).click();
    }
    assert.equal(await chart.evaluate(()=>noticeDialogOpen),false);
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('hide/show, timeframe switch and symbol switch clear and restore owned display');
    await chart.evaluate(()=>widget.activeChart().getStudyById(widget.activeChart().getAllStudies()[0].id).setInputValues([
      {id:'high_strength',value:5},{id:'low_strength',value:5}]));
    await chart.waitForFunction(()=>document.querySelector('.mw-swing-card')?.textContent.includes('Swing 5 5'));
    await chart.evaluate(()=>widget.changeTheme('Light'));
    await page.setViewportSize({width:375,height:844});
    await chart.waitForFunction(()=>widget.activeChart().dataReady());
    // Native canvas redraw after theme/viewport changes runs independently of
    // the HTML card's layout; let that redraw finish before the visual capture.
    await chart.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,1000))));
    await chart.waitForFunction(()=>document.querySelector('.mw-swing-card')?.getBoundingClientRect().right<=innerWidth);
    assert.equal(await chart.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(ROOT,'artifacts/swing-application-narrow-light.png')});
    await page.setViewportSize({width:1900,height:950});
    await chart.evaluate(()=>widget.changeTheme('Dark'));
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('375px light card bounds and no horizontal overflow');
    await chart.evaluate(async () => {
      widget.setLayout('s');
      const c = widget.activeChart();
      for (const item of c.getAllStudies()) c.removeEntity(item.id);
      for (const name of ['SMA','EMA','LWMA','ATR','RSI','MACD','STOCH','BBANDS'])
        await c.createStudy('守望 Python ' + name, false, false);
    });
    await chart.waitForFunction(() => widget.activeChart().getAllStudies().length === 8);
    const legacy = await inputs(chart);
    const legacyName='旧八指标模板 '+Date.now();
    const legacyUI=chart.childFrames()[0];
    await legacyUI.getByRole('button',{name:'保存或应用指标模板',exact:true}).click();
    await legacyUI.getByText('保存指标模板',{exact:true}).filter({visible:true}).click();
    await legacyUI.locator('input[maxlength="64"]').fill(legacyName);
    await legacyUI.locator('input[maxlength="64"]').press('Enter');
    await page.waitForFunction(async name=>(await(await fetch('/api/advanced-charts/preferences')).json())
      .some(row=>row.kind==='study' && row.name===name),legacyName);
    await chart.evaluate(()=>{const c=widget.activeChart();for(const study of c.getAllStudies()) c.removeEntity(study.id);});
    await legacyUI.getByRole('button',{name:'保存或应用指标模板',exact:true}).click();
    await legacyUI.getByText(legacyName,{exact:true}).filter({visible:true}).click();
    await chart.waitForFunction(()=>widget.activeChart().getAllStudies().length===8);
    assert.deepEqual(await inputs(chart),legacy,'all previous indicators restore through preferences template');
    await save(chart);
    await page.reload();
    chart = await frame();
    assert.deepEqual(await inputs(chart), legacy, 'all eight previous Python indicators restore in the real workspace');
    console.log("Acceptance checkpoint", validations.length+1);
    validations.push('old eight indicators preferences template and workspace restore');
    await chart.evaluate(()=>{const c=widget.activeChart();for(const study of c.getAllStudies()) c.removeEntity(study.id);});
    await chart.waitForFunction(()=>!document.querySelector('.mw-swing-row') && widget.activeChart().getAllShapes().length===0);
    await chart.evaluate(()=>widget.activeChart().createStudy('守望 Python SWING_SR_V1',false,false));
    await chart.waitForFunction(()=>document.querySelector('.mw-swing-row')?.textContent.includes('高点 15根'));
    await chart.evaluate(()=>{
      const c=widget.activeChart();c.getTimeScale().setBarSpacing(13);c.getTimeScale().setRightOffset(12);
    });
    await save(chart);
    const timing=await page.evaluate(async()=>{
      const {csrf}=await(await fetch('/api/session')).json();const timings=[];
      for(let i=0;i<5;i++) {
        const start=performance.now();const response=await fetch('/api/charts/data',{method:'POST',
          headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({
            instrument:'EURUSD',series_kind:'managed',timeframe:'H4',published:true,limit:175,
            indicators:[{name:'SWING_SR_V1'}],provisional:true})});
        if(!response.ok) throw Error('timing request '+response.status);await response.json();timings.push(performance.now()-start);
      }
      return timings;
    });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(ROOT, 'artifacts/swing-application-acceptance.json'), JSON.stringify({
      passed: true, app: APP, chart: CHART, presentation, workspace: workspace.id,
      template: template.id, expected, legacy, requests, errors, validations, defaultStyles, geometry, screenshotGeometry,firstShared, multiShared,timing,historyBoundary,staleSnapshot,
    }, null, 2));
    console.log('Swing Docker app: frozen values, shared SSE rollback/confirmation, workspace, preferences template and two charts passed');
  } catch (error) {
    await page.screenshot({ path: path.join(ROOT, 'artifacts/swing-application-failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(ROOT, 'artifacts/swing-application-failure.json'), JSON.stringify({
      error: String(error), stack: error.stack, errors, requests,
      state:await page.frames().find(frame=>frame.url().startsWith(CHART+'/'))?.evaluate(()=>({
        ready:typeof ready!=='undefined'&&ready,loading,nativeSaving,noticeDialogOpen,
        studies:Array.from({length:widget.chartsCount()},(_,index)=>widget.chart(index).getAllStudies()),
        error:document.getElementById('error')?.textContent})).catch(()=>null),
      frames: page.frames().map(item => item.url()),
    }, null, 2));
    throw error;
  } finally {
    try { if (changedFixture) tick('restore'); }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
