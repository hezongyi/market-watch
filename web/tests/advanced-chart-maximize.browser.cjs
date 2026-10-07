// Real licensed engine and mouse gestures, entirely routed in Playwright.
// No listening server, application API, database or production connection.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const origin = "https://mw-double-click.invalid";
const output = process.env.MAXIMIZE_OUTPUT || "/tmp/mw-chart-maximize-browser.json";
const report = { environment: "Ubuntu Playwright routed native-library fixture", cpuRate:Number(process.env.MAXIMIZE_CPU_RATE || 1), cases: [], errors: [] };

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  if(report.cpuRate!==1) {
    const session=await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate',{rate:report.cpuRate});
  }
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("requestfailed", r => report.errors.push(`${r.url()}: ${r.failure()?.errorText}`));
  await page.clock.setFixedTime(new Date("2026-09-29T00:00:00Z"));
  let html = fs.readFileSync(path.join(__dirname, "fixtures/native-history.html"), "utf8");
  html = html.replace("enabled_features:[", "enabled_features:['support_multicharts', 'header_layouttoggle',");
  html = html.replace("const widget=new TradingView.widget({", "const widget=new TradingView.widget({save_load_adapter:{getDrawingTemplates:async()=>[]},");
  html = html.replace("<script>\n// Standalone", '<script src="/chart-maximize.js"></script><script src="/sync-coordinator.js"></script>\n<script>\n// Standalone');
  html += `<script>widget.onChartReady(() => {
    globalThis.MWChartMaximize = chartBlankDoubleClick(widget, {readonly: options.has('readonly')});
    globalThis.maximizeCalls=[];
    const handle=MWChartMaximize.handle;
    MWChartMaximize.handle=(p,e)=>{
      const call={target:e.target?.tagName,touch:e.isTouch,main:p.containsMainSeries(),
        paneMax:p.state().maximized().value(),count:widget.chartsCount(),
        full:p._chart.getResizerDetacher().fullscreenable.value()};
      maximizeCalls.push(call);call.handled=handle(p,e);return call.handled;
    };
    globalThis.MWSyncCoordinator = chartSyncCoordinator(widget);
    widget.subscribe('layout_changed', () => MWSyncCoordinator.refreshCharts());
  });</script>`;
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    // The library may request optional telemetry. Serve an empty response in
    // this isolated browser; no external request is ever forwarded.
    if (url.origin !== origin) return route.fulfill({status:204,body:""});
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
    const file = path.resolve(root, "advanced-host", "." + decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(path.join(root, "advanced-host") + path.sep));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" };
    return route.fulfill({ contentType: mime[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
  });

  const record = (name, data = {}) => { report.cases.push({ name, ...data }); console.log("PASS", name); };
  const settle = async () => {
    await page.waitForFunction(() => ready && Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).every(c=>c.dataReady()));
    await page.waitForFunction(()=>!MWChartMaximize.resizing());
    await page.evaluate(() => new Promise(resolve => {
      let previous,stable=0;
      const sample=()=>{
        const current=JSON.stringify(Array.from({length:widget.chartsCount()},(_,i)=>{
          const c=widget.chart(i);return [c.getTimeScale().width(),c.getVisibleRange(),c.getTimeScale().barSpacing()];
        }));
        stable=current===previous?stable+1:0;previous=current;
        if(stable>=3)resolve();else requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    }));
  };
  const mainPane = async (i, extraPane = false) => page.evaluate(({i, extraPane}) => {
    const pane = widget.chart(i)._chartWidget.paneWidgets().find(p => p.containsMainSeries() !== extraPane);
    const r = pane.canvasElement().getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  }, {i, extraPane});
  // Ask the actual renderer's hit tester for blank canvas coordinates. This is
  // observation only; every action below is dispatched through real mouse input.
  const point = async (i, extraPane = false, hit = false, sourceType = null) => {
    const p = await page.evaluate(({i,extraPane,hit,sourceType}) => {
      const pane = widget.chart(i)._chartWidget.paneWidgets().find(p => p.containsMainSeries() !== extraPane);
      const r = pane.canvasElement().getBoundingClientRect();
      for (let y=50;y<r.height-35;y+=10) for(let x=80;x<r.width-35;x+=10) {
        const h=pane._dataSourceAtPoint(x,y);
        const element=pane.canvasElement().ownerDocument.elementFromPoint(r.x+x,r.y+y);
        if(sourceType==='candle' && h?.source !== pane._chartModel().mainSeries()) continue;
        if(sourceType==='drawing' && !widget.chart(i).getAllShapes().some(s=>s.id===h?.source.id())) continue;
        if (!!h === hit && element?.tagName === 'CANVAS') return {x:r.x+x,y:r.y+y};
      }
      throw Error('No suitable native hit-test coordinate');
    },{i,extraPane,hit,sourceType});
    const frame = page.frames().find(f => f.parentFrame() === page.mainFrame());
    const box = await (await frame.frameElement()).boundingBox();
    return {x:p.x+box.x,y:p.y+box.y};
  };
  const double = async (i, extraPane = false) => {
    const p = await point(i, extraPane);
    await page.mouse.dblclick(p.x,p.y);
    await settle();
  };
  const state = () => page.evaluate(() => ({
    layout:widget.layout(), active:widget.activeChartIndex(), sync:MWSyncCoordinator.snapshot(),
    charts:Array.from({length:widget.chartsCount()},(_,i)=> {
      const c=widget.chart(i);
      return {symbol:c.symbol(),resolution:c.resolution(),spacing:c.getTimeScale().barSpacing(),
        offset:c.getTimeScale().rightOffset(),range:c.getVisibleRange(),max:c.isMaximized(),
        studies:c.getAllStudies(),shapes:c.getAllShapes(),
        panes:c._chartWidget.paneWidgets().map(p=>p.state().maximized().value())};
    }),
  }));

  try {
    await page.goto(origin + "/?initialCount=1000");
    await settle();
    await page.evaluate(() => widget.setLayout("4"));
    await settle();
    await page.evaluate(async()=>{
      await widget.chart(1).setSymbol('TEST-B',{doNotActivateChart:true});
      await widget.chart(3).setResolution('5',{doNotActivateChart:true});
    });
    await settle();
    // Retain an indicator subpane and drawing through the entire round trip.
    await page.evaluate(async () => {
      await widget.chart(2).createStudy("Relative Strength Index", false, false);
      widget.chart(2).createShape({time:END/1000-86400*5,price:105},{shape:"horizontal_line"});
      widget.setActiveChart(0);
    });
    await settle();
    await page.waitForTimeout(300);
    const before = await state();
    await double(2);
    let after = await state();
    assert.equal(after.active,2);
    assert.ok(after.charts[2].max);
    assert.ok(after.charts[2].panes.every(v=>!v));
    record("inactive main chart blank double click maximizes whole chart with subpane", {before,after});
    await page.waitForTimeout(550);
    await double(2);
    after = await state();
    assert.ok(after.charts.every(c=>!c.max));
    assert.equal(after.layout,before.layout);
    assert.deepEqual(after.charts,before.charts);
    record("double click restores original four-chart state and studies/drawing");
    const geometryBefore=await Promise.all([0,1,2,3].map(i=>mainPane(i)));
    await page.evaluate(()=>widget.setActiveChart(1));
    const keyboardPoint=await point(1);
    await page.mouse.click(keyboardPoint.x,keyboardPoint.y);
    await page.keyboard.press('Alt+Enter');
    await settle();
    assert.ok((await state()).charts[1].max);
    await page.waitForTimeout(550);
    await double(1);
    assert.ok((await state()).charts.every(c=>!c.max));
    assert.deepEqual(await Promise.all([0,1,2,3].map(i=>mainPane(i))),geometryBefore);
    record("keyboard maximize can be restored by double click with identical grid geometry");

    // Negative cases use native tool selection and genuine pointer events.
    for(const tool of ['trend_line','measure','zoom']) {
      await page.waitForTimeout(550);
      const toolPoint=await point(0);
      await page.mouse.move(toolPoint.x,toolPoint.y);
      await page.evaluate(tool=>widget.selectLineTool(tool),tool);
      assert.equal(await page.evaluate(()=>widget.selectedLineTool()),tool,'requested tool is active');
      await page.mouse.dblclick(toolPoint.x,toolPoint.y);
      await settle();
      assert.ok((await state()).charts.every(c=>!c.max));
      await page.keyboard.press('Escape');
      await page.evaluate(()=>widget.selectLineTool('cursor'));
      await page.evaluate(()=>widget.chart(0).getPanes().forEach(p=>p.setMaximized(false)));
      record(tool + " tool does not trigger whole-chart maximize");
    }

    const native=page.frames().find(f=>f.parentFrame()===page.mainFrame());
    for(const kind of ['candle','drawing']) {
      const hitPoint=await point(0,false,true,kind);
      await page.waitForTimeout(550);
      await page.mouse.dblclick(hitPoint.x,hitPoint.y);
      await settle();
      assert.ok((await state()).charts.every(c=>!c.max));
      assert.ok(await native.getByRole('dialog').count()>0,'native source properties still opens');
      await page.keyboard.press('Escape');
      record(kind + " double click retains native properties dialog");
    }

    for (const axis of ['price','time']) {
      const b=await mainPane(0);
      const frameBox=await (await native.frameElement()).boundingBox();
      const x=frameBox.x+b.x+(axis==='price'?b.width+15:b.width*.55);
      const y=frameBox.y+b.y+(axis==='time'?b.height+12:b.height*.5);
      await page.waitForTimeout(550);
      await page.mouse.dblclick(x,y);
      await settle();
      assert.ok((await state()).charts.every(c=>!c.max));
      record(axis + " axis double click does not maximize chart");
    }

    await page.waitForTimeout(550);
    await double(2,true);
    after=await state();
    assert.ok(!after.charts[2].max);
    assert.ok(after.charts[2].panes.some(Boolean));
    await page.waitForTimeout(550);
    await double(2,true);
    assert.ok((await state()).charts[2].panes.every(v=>!v));
    record("RSI blank double click retains native pane maximize/restore");

    // Normalize periods only for the synchronization cases below; the earlier
    // round trip verifies independent symbols and resolutions are preserved.
    await page.evaluate(()=>widget.chart(3).setResolution('1D',{doNotActivateChart:true}));
    await settle();

    // Rapid separate double-click gestures must not restore a stale state.
    for(let n=0;n<4;n++) {
      await double(3);
      assert.equal((await state()).charts[3].max,n%2===0);
    }
    record("rapid maximize/restore follows current native state");

    for (const mode of ["barWidth","date"]) {
      await page.evaluate(mode=>MWSyncCoordinator.configure({date:mode==='date',barWidth:mode==='barWidth',time:false}),mode);
      await settle();
      const prior=await state();
      await page.waitForTimeout(550);
      await double(1);
      await page.waitForTimeout(550);
      await double(1);
      const restored=await state();
      assert.deepEqual(restored.sync,prior.sync);
      assert.deepEqual(restored.charts.map(c=>c.spacing),prior.charts.map(c=>c.spacing));
      record(mode + " synchronization ignores maximize resize",{prior,restored});
      assert.equal(await page.evaluate(()=>MWChartMaximize.resizing()),false);
      const mouse=await point(1);
      await page.mouse.move(mouse.x,mouse.y);
      await page.mouse.wheel(0,-120);
      await page.waitForTimeout(400);
      const zoomed=await state();
      assert.notEqual(zoomed.charts[1].spacing,restored.charts[1].spacing);
      if(mode==='barWidth') assert.ok(zoomed.charts.every(c=>Math.abs(c.spacing-zoomed.charts[1].spacing)<1e-6));
      else assert.ok(zoomed.charts.every(c=>Math.abs(c.range.from-zoomed.charts[1].range.from)<86400));
      record(mode + " real wheel synchronization remains active after restore");
    }

    await page.evaluate(()=>MWSyncCoordinator.configure({date:false,barWidth:false,time:false}));
    await page.evaluate(()=>widget.setLayout('2h'));
    await settle();
    const splitter=native.locator('[class*="chart-widget-collection-border--"]').first();
    const splitBox=await splitter.boundingBox();
    assert.ok(splitBox);
    const widthBefore=(await mainPane(0)).width;
    await page.mouse.move(splitBox.x+splitBox.width/2,splitBox.y+splitBox.height/2);
    await page.mouse.down();
    await page.mouse.move(splitBox.x+splitBox.width/2+120,splitBox.y+splitBox.height/2,{steps:12});
    await page.mouse.up();
    await settle();
    const twoGeometry=await Promise.all([0,1].map(i=>mainPane(i)));
    assert.ok(twoGeometry[0].width>widthBefore+90,'real splitter drag changes grid proportions');
    await double(1);
    assert.ok((await state()).charts[1].max);
    await page.waitForTimeout(550);
    await double(1);
    assert.deepEqual(await Promise.all([0,1].map(i=>mainPane(i))),twoGeometry);
    record('two-chart maximize restores genuinely dragged divider proportions');

    await page.evaluate(()=>widget.setLayout('8'));
    await settle();
    for (const i of [0,7,3]) {
      await page.waitForTimeout(550);
      await double(i);
      assert.ok((await state()).charts[i].max);
      await page.waitForTimeout(550);
      await double(i);
      assert.ok((await state()).charts.every(c=>!c.max));
    }
    record("eight-chart first/last/middle chart round trips");

    await page.evaluate(()=>widget.setLayout('s'));
    await settle();
    await double(0);
    assert.ok(!(await state()).charts[0].max);
    record("single-chart layout does not switch whole-chart maximize");

    await page.goto(origin + "/?initialCount=1000&readonly");
    await settle();
    await page.evaluate(()=>widget.setLayout('4'));
    await settle();
    await double(0);
    assert.ok((await state()).charts.every(c=>!c.max));
    record("read-only host does not use the desktop gesture");

    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await page.goto(origin + '/?initialCount=1000');
    await settle();
    await page.evaluate(()=>widget.setLayout('4'));
    await settle();
    const touchPoint=await point(3);
    for(let n=0;n<2;n++) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touchPoint,id:1}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForTimeout(60);
    }
    await settle();
    assert.equal((await state()).active,3,'touch input actually activates target chart');
    assert.ok((await state()).charts.every(c=>!c.max));
    record('touch double tap retains native behavior without whole-chart maximize');

    // Tear down while a resize callback is pending, as a workspace replacement
    // does. A callback must never keep querying a removed native widget.
    await page.evaluate(()=>{
      const pane=widget.chart(0)._chartWidget.paneWidgets().find(p=>p.containsMainSeries());
      const canvas=pane.canvasElement();
      // Lifecycle verification calls the existing native-validated entry only
      // here; all interaction cases above use actual mouse/touch dispatch.
      MWChartMaximize.handle(pane,{target:canvas,isTouch:false});
      MWSyncCoordinator.dispose();
      MWChartMaximize.dispose();
      widget.remove();
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>MWChartMaximize.resizing()),false);
    record('workspace teardown cancels pending resize observations');
    assert.deepEqual(report.errors,[]);
  } finally {
    report.lastState = await state().catch(()=>null);
    report.maximizeCalls = await page.evaluate(()=>maximizeCalls).catch(()=>null);
    fs.writeFileSync(output, JSON.stringify(report,null,2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode=1; });
