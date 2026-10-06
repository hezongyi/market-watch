// In-process route fixture with the actual licensed widget. No server, Docker,
// production endpoint, or authentication state is used by this interface probe.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "../..");
const output =
  process.env.CHART_ALERT_PROBE_OUTPUT ||
  "/tmp/mw-chart-alerts-acceptance/native-probe.json";
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const { execFileSync } = require("node:child_process");
const indicatorFixture = JSON.parse(
  execFileSync(
    process.env.CHART_ALERT_PROBE_PYTHON || path.join(ROOT, ".venv/bin/python"),
    [
      "-c",
      `
import json
from datetime import datetime, timedelta, timezone
from alerts.chart_indicators import public_catalog, calculate
from alerts.chart_alert_domain import Operand
from alerts.chart_alert_values import operand_values
rows=[]; at=datetime(2026,10,1,tzinfo=timezone.utc)
while len(rows)<500:
    if at.weekday()<5:
        i=len(rows); start=int(at.timestamp()*1000)
        rows.append(dict(start=start,end=start+3600000,open=100+i%7,high=112,low=90,close=101+i%7,complete=True))
    at+=timedelta(hours=1)
rows[-1]['complete']=False
catalog={name:meta for name,meta in public_catalog().items() if name in ('SMA','EMA','RSI','MACD')}
outputs={}; expected={}
for name,meta in catalog.items():
    spec=dict(name=name,params=meta['params'],version='1')
    result=calculate(rows,spec,provisional=True)
    outputs[name]={s['key']:s['values'] for s in result['series']}
    expected[name]={s['key']:[float(v) if v is not None else None for v in operand_values(rows,Operand(kind='indicator',indicator={**spec,'output':s['key']}),provisional=True)] for s in result['series']}
print(json.dumps(dict(catalog=catalog,outputs=outputs,expected=expected)))
`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "backend") },
      encoding: "utf8",
    },
  ),
);
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 950 },
    }),
    page = await context.newPage();
  const errors = [],
    report = {
      scope:
        "actual licensed chart / in-process routed synthetic fixture; no deployed instance",
      cases: [],
    };
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("https://chart-alert-probe.invalid/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><style>html,body,#chart{margin:0;height:100%}</style></head><body><div id="chart"></div><script src="/charting_library/charting_library.js"></script><script src="/series.js"></script><script src="/indicators.js"></script><script src="/fixture.js"></script></body></html>`,
      });
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: `
      const bars=[];let time=Date.UTC(2026,9,1,0)/1000;
      for(let i=0;bars.length<500;i++,time+=3600){const day=new Date(time*1000).getUTCDay();if(day===0||day===6)continue;bars.push({time:time*1000,open:100+bars.length%7,high:112,low:90,close:101+bars.length%7,volume:1});}
      globalThis.probeBars=bars;
      globalThis.probeIndicatorFixture=${JSON.stringify(indicatorFixture)};
      globalThis.probeRenderedIndicators={};
      const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['60','120'],supports_time:true,supports_marks:false,supports_timescale_marks:false}),0),resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'crypto',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,supported_resolutions:['60','120'],has_weekly_and_monthly:false,volume_precision:0}),0),getBars:(symbol,res,p,cb)=>setTimeout(()=>{
        let rows=bars;
        if(symbol.ticker.startsWith('MWPY_')){
          const {spec,key}=MWSeries.decode(symbol.ticker), values=probeIndicatorFixture.outputs[spec.name][key];
          rows=bars.map((b,i)=>({time:b.time,open:values[i].value??0,high:values[i].value??0,low:values[i].value??0,close:values[i].value??0,volume:Number(values[i].value!==null)}));
        }
        if (res === '120') {
          const buckets = new Map();
          for (const b of rows) {
            const time = Math.floor(b.time / 7200000) * 7200000, old = buckets.get(time);
            if (old) {old.high=Math.max(old.high,b.high);old.low=Math.min(old.low,b.low);old.close=b.close;old.volume+=b.volume;}
            else buckets.set(time,{...b,time});
          }
          rows=[...buckets.values()];
        }
        rows=rows.filter(b=>b.time/1000<p.to);cb(rows.slice(-p.countBack),{noData:!rows.length});},0),subscribeBars:()=>{},unsubscribeBars:()=>{},getServerTime:cb=>cb(bars.at(-1).time/1000+3600)};
      const studies=PineJS=>pythonStudies(PineJS,probeIndicatorFixture.catalog).map(study=>{
        const construct=study.constructor, name=study.name.split(' ').at(-1);
        study.constructor=function(){construct.call(this);const main=this.main;this.main=function(ctx){
          const values=main.call(this,ctx);const at=PineJS.Std.time(ctx);
          (probeRenderedIndicators[name]||={})[at]=values.map(v=>Number.isFinite(v)?v:null);return values;
        };};return study;
      });
      globalThis.widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,symbol:'BTCUSDT',interval:'60',locale:'zh',autosize:true,timezone:'Etc/UTC',custom_indicators_getter:PineJS=>Promise.resolve(studies(PineJS)),disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default'],enabled_features:['support_multicharts'],context_menu:{items_processor:(items,factory,params)=>{globalThis.lastMenu=params;return globalThis.probeAdapter ? probeAdapter.menu(items,factory,params) : Promise.resolve(items);}}});
      widget.onChartReady(()=>{globalThis.ready=true;});
    `,
      });
    const file = path.join(ROOT, "advanced-host", url.pathname);
    if (
      !file.startsWith(path.join(ROOT, "advanced-host") + path.sep) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    )
      return route.fulfill({ status: 404, body: "fixture missing" });
    return route.fulfill({
      path: file,
      ...(file.endsWith(".js")
        ? { contentType: "text/javascript; charset=utf-8" }
        : {}),
    });
  });
  try {
    await page.goto("https://chart-alert-probe.invalid/");
    await page.waitForFunction(
      () => globalThis.ready && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    report.cases.push("actual widget ready");
    report.geometry = await page.evaluate(async () => {
      const chart = widget.activeChart(),
        gap = probeBars.findIndex(
          (bar, i) => i > 30 && bar.time - probeBars[i - 1].time > 3600000,
        );
      const selected = probeBars.slice(gap - 10, gap + 25),
        first = probeBars[gap - 4],
        last = probeBars[gap + 4];
      await chart.setVisibleRange({
        from: selected[0].time / 1000,
        to: selected.at(-1).time / 1000,
      });
      const horizontal = await chart.createShape(
        { time: first.time / 1000, price: 100 },
        { shape: "horizontal_line" },
      );
      const ray = await chart.createShape(
        { time: first.time / 1000, price: 100 },
        { shape: "horizontal_ray" },
      );
      const trend = await chart.createMultipointShape(
        [
          { time: first.time / 1000, price: 95 },
          { time: last.time / 1000, price: 110 },
        ],
        { shape: "trend_line", overrides: { extendRight: true } },
      );
      const slopingRay = await chart.createMultipointShape(
        [
          { time: first.time / 1000, price: 95 },
          { time: last.time / 1000, price: 110 },
        ],
        { shape: "ray" },
      );
      const reversedRay = await chart.createMultipointShape(
        [
          { time: last.time / 1000, price: 110 },
          { time: first.time / 1000, price: 95 },
        ],
        { shape: "ray" },
      );
      const scale = chart.getTimeScale(),
        width = scale.width(),
        spacing = scale.barSpacing();
      const xFor = (time) => {
        const boundary = (after) => {
          let lo = 0,
            hi = width;
          for (let n = 0; n < 40; n++) {
            const mid = (lo + hi) / 2,
              value = scale.coordinateToTime(mid);
            if (value !== null && (after ? value > time : value >= time))
              hi = mid;
            else lo = mid;
          }
          return (lo + hi) / 2;
        };
        return (boundary(false) + boundary(true)) / 2;
      };
      return {
        shapes: chart.getAllShapes(),
        geometry: [horizontal, ray, trend, slopingRay].map((id) => ({
          id,
          points: chart.getShapeById(id).getPoints(),
          properties: chart.getShapeById(id).getProperties(),
        })),
        barSpacing: spacing,
        stepCount: 8,
        measuredStepCount:
          (xFor(last.time / 1000) - xFor(first.time / 1000)) / spacing,
        reversedRay: {
          points: chart.getShapeById(reversedRay).getPoints(),
          properties: chart.getShapeById(reversedRay).getProperties(),
        },
        rawTimes: [first.time, last.time],
        days: selected.map((b) => new Date(b.time).getUTCDay()),
        priceScaleMode: chart.getPanes()[0].getMainSourcePriceScale().getMode(),
      };
    });
    assert.equal(report.geometry.geometry.length, 4);
    assert.ok(
      report.geometry.rawTimes[1] - report.geometry.rawTimes[0] > 8 * 3600000,
      "fixture must actually cross the closed weekend",
    );
    assert.ok(
      Math.abs(report.geometry.measuredStepCount - 8) < 0.05,
      "native time scale must interpolate by eight actual bars",
    );
    report.cases.push(
      "native public time scale matches eight actual bar indices",
    );
    await page.addScriptTag({
      path: path.join(ROOT, "advanced-host/chart-alerts.js"),
    });
    report.adapter = await page.evaluate(async () => {
      const chart = widget.activeChart(),
        messages = [],
        writes = [];
      globalThis.probeMessages = messages;
      globalThis.probeWrites = writes;
      globalThis.probeEpoch = 1;
      globalThis.probeLoading = false;
      globalThis.probeAdapter = chartAlertBridge({
        getWidget: () => widget,
        getWorkspace: () => ({ id: "fixture" }),
        getEpoch: () => probeEpoch,
        isLoading: () => probeLoading,
        readonly: false,
        metadata: () => ({ source: "binance" }),
        frames: { 60: "H1", 120: "H2" },
        calculationOrigin: () => probeBars[0].time,
        send: (m) => messages.push(m),
        fail: (e) => {
          throw e;
        },
        rpc: async (q) => {
          writes.push(q);
          if (q.op === "geometry") {
            const a = q.args;
            const first = probeBars.findIndex(
              (b) => b.time === a.points[0].time,
            );
            return {
              kind: a.kind,
              scale: a.scale,
              extend_left: a.extend_left,
              extend_right: a.extend_right,
              mapping_version: "bar-index-v1",
              points: a.points.map((p) => ({
                ...p,
                index: probeBars.findIndex((b) => b.time === p.time) - first,
              })),
            };
          }
          if (q.op === "read") return structuredClone(probeBackendRow);
          if (q.op === "edit") {
            if (q.version !== probeBackendRow.version)
              throw Error("fixture version conflict");
            probeBackendRow = {
              ...probeBackendRow,
              version: q.version + 1,
              config: {
                ...probeBackendRow.config,
                condition: { right: { line: q.line } },
              },
            };
            return structuredClone(probeBackendRow);
          }
          if (q.op === "lifecycle") {
            probeBackendRow = {
              ...probeBackendRow,
              status: "paused",
              health_reason: "关联画线已明确删除",
            };
            return structuredClone(probeBackendRow);
          }
          throw Error("unexpected fixture request");
        },
      });
      probeAdapter.attach();
      widget.subscribe("chart_load_requested", () => {
        probeLoading = true;
        probeEpoch++;
      });
      widget.subscribe("chart_loaded", () => {
        probeLoading = false;
        probeAdapter.refresh();
      });
      const reverseId = chart
        .getAllShapes()
        .filter((s) => s.name === "ray")[1].id;
      await probeAdapter.create({
        chart,
        object: { type: "shape", id: reverseId },
      });
      const reverse = messages.find((m) => m.type === "chart-alert-context")
        .context.line;
      if (!reverse.extend_left || reverse.extend_right)
        throw Error("reversed native ray extension must point left only");
      messages.length = 0;
      writes.length = 0;
      const chartId = probeAdapter.diagnostics().charts[0],
        point = { time: probeBars[40].time, price: "100", index: 0 };
      const row = {
        id: "fixture-alert",
        version: 1,
        name: "恢复核对",
        status: "active",
        health_reason: null,
        config: {
          instrument: "BTCUSDT",
          source: "binance",
          series_kind: "managed",
          timeframe: "H1",
          association: {
            workspace_id: "fixture",
            chart_id: chartId,
            chart_index: 0,
            object_id: "business-object",
            object_kind: "drawing",
            native_object_id: "missing",
          },
          condition: {
            right: {
              line: {
                kind: "horizontal_line",
                scale: "linear",
                mapping_version: "bar-index-v1",
                points: [point],
                extend_left: false,
                extend_right: false,
              },
            },
          },
        },
      };
      globalThis.probeBackendRow = structuredClone(row);
      probeAdapter.setRows([row]);
      const wait = async () => {
        for (
          let i = 0;
          i < 100 &&
          !messages.some((m) => m.type === "chart-alert-association");
          i++
        )
          await new Promise((r) => setTimeout(r, 20));
      };
      await wait();
      const restored = chart
        .getAllShapes()
        .find(
          (s) =>
            s.name === "horizontal_line" &&
            chart.getShapeById(s.id).getPoints()[0].time === point.time / 1000,
        );
      if (!restored)
        throw Error(
          "backend-associated drawing was not restored after refresh",
        );
      const before = chart.getAllShapes().length;
      // A layout may have persisted an old drawing position; the saved backend
      // version is authoritative, without submitting a phantom user edit.
      row.version = 2;
      row.config.condition.right.line.points[0].price = "101";
      globalThis.probeBackendRow = structuredClone(row);
      messages.length = 0;
      probeAdapter.setRows([row]);
      await wait();
      const current = chart.getShapeById(restored.id).getPoints()[0].price;
      return {
        restored: !!restored,
        shapeCountStable: chart.getAllShapes().length === before,
        restoredPrice: current,
        writes: writes.length,
      };
    });
    assert.equal(report.adapter.restoredPrice, 101);
    assert.equal(report.adapter.shapeCountStable, true);
    assert.equal(report.adapter.writes, 0);
    report.cases.push(
      "native refresh restores backend snapshot without duplicate shapes or authenticated writes",
    );
    // Exercise actual native pointer events, not a manually emitted adapter event.
    await page.evaluate(() => {
      const chart = widget.activeChart();
      const point = probeBackendRow.config.condition.right.line.points[0];
      const target = chart
        .getAllShapes()
        .find(
          (s) =>
            s.name === "horizontal_line" &&
            chart.getShapeById(s.id).getPoints()[0].time === point.time / 1000,
        );
      globalThis.probeDragId = target.id;
      chart
        .getShapeById(target.id)
        .setProperties({ linecolor: "#00cc00", linewidth: 4 });
      probeWrites.length = 0;
      globalThis.probeNativeEvents = [];
      widget.subscribe("drawing_event", (id, type) =>
        probeNativeEvents.push({ id, type }),
      );
      widget.subscribe("mouse_down", (p) =>
        probeNativeEvents.push({ type: "mouse_down", p }),
      );
      widget.subscribe("mouse_up", (p) =>
        probeNativeEvents.push({ type: "mouse_up", p }),
      );
      widget.subscribe("undo", () => probeNativeEvents.push({ type: "undo" }));
      widget.subscribe("redo", () => probeNativeEvents.push({ type: "redo" }));
    });
    await page.waitForTimeout(150);
    const dragShot = output.replace(/\.json$/, ".drag-before.png");
    await page.screenshot({ path: dragShot });
    const dragY = Number(
      execFileSync(
        "python",
        [
          "-c",
          `
import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB')
ys=[y for y in range(50,im.height-70) for x in range(795,806) if (lambda r,g,b:r<30 and 150<g<230 and b<30)(*im.getpixel((x,y)))]
assert ys, 'associated native horizontal line must be visible'
print(sum(ys)/len(ys))
`,
          dragShot,
        ],
        { encoding: "utf8" },
      ),
    );
    await page.mouse.move(800, dragY);
    await page.mouse.down();
    await page.mouse.move(800, dragY - 35, { steps: 12 });
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(
        () => probeWrites.filter((q) => q.op === "edit").length,
      ),
      0,
      "actual pointer drag must remain a preview until release",
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: output.replace(/\.json$/, ".drag-after.png"),
    });
    await page.waitForFunction(
      () => probeWrites.some((q) => q.op === "edit"),
      null,
      { timeout: 5000 },
    );
    report.drag = await page.evaluate(() => ({
      version: probeBackendRow.version,
      price: probeBackendRow.config.condition.right.line.points[0].price,
      edits: probeWrites.filter((q) => q.op === "edit").length,
      events: probeNativeEvents,
    }));
    assert.equal(report.drag.version, 3);
    assert.equal(report.drag.edits, 1);
    assert.notEqual(Number(report.drag.price), 101);
    report.cases.push(
      "actual native mouse drag previews without writes and commits one version on release",
    );
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    await page.waitForFunction(() => probeBackendRow.version === 4, null, {
      timeout: 5000,
    });
    assert.equal(
      await page.evaluate(() =>
        Number(probeBackendRow.config.condition.right.line.points[0].price),
      ),
      101,
    );
    await page.keyboard.press("Control+y");
    await page.waitForFunction(() => probeBackendRow.version === 5, null, {
      timeout: 5000,
    });
    assert.equal(
      await page.evaluate(() =>
        Number(probeBackendRow.config.condition.right.line.points[0].price),
      ),
      Number(report.drag.price),
    );
    report.cases.push(
      "native undo and redo submit new geometry versions while preserving monitoring lifecycle",
    );
    await page.mouse.click(700, 75, { button: "right" });
    const nativeFrame = page
      .frames()
      .find((frame) => frame !== page.mainFrame());
    await page.waitForTimeout(300);
    await nativeFrame
      .getByText(/在 [0-9.]+ 创建价格告警/)
      .click({ timeout: 5000 });
    const priceContext = await page.evaluate(
      () =>
        probeMessages.filter((m) => m.type === "chart-alert-context").at(-1)
          ?.context,
    );
    assert.ok(
      Number(priceContext?.price) > 0,
      "native main-price context menu must prefill the clicked price",
    );
    report.cases.push(
      "actual native context menu prefills clicked main-series price",
    );
    report.logGeometry = await page.evaluate(async () => {
      const chart = widget.activeChart();
      for (const s of chart.getAllShapes())
        chart.getShapeById(s.id).setProperties({ visible: false });
      const gap = probeBars.findIndex(
          (bar, i) => i > 30 && bar.time - probeBars[i - 1].time > 3600000,
        ),
        first = probeBars[gap - 4],
        last = probeBars[gap + 4],
        middle = probeBars[gap];
      const scale = chart.getPanes()[0].getMainSourcePriceScale();
      scale.setMode(1);
      scale.setAutoScale(false);
      scale.setVisiblePriceRange({ from: 80, to: 500 });
      const trend = await chart.createMultipointShape(
        [
          { time: first.time / 1000, price: 100 },
          { time: last.time / 1000, price: 400 },
        ],
        {
          shape: "trend_line",
          overrides: { linecolor: "#ff0000", linewidth: 4 },
        },
      );
      await chart.createShape(
        { time: first.time / 1000, price: 200 },
        {
          shape: "horizontal_line",
          overrides: { linecolor: "#0000ff", linewidth: 4 },
        },
      );
      const ts = chart.getTimeScale(),
        width = ts.width();
      const boundary = (after) => {
        let lo = 0,
          hi = width;
        for (let n = 0; n < 40; n++) {
          const x = (lo + hi) / 2,
            t = ts.coordinateToTime(x);
          if (
            t !== null &&
            (after ? t > middle.time / 1000 : t >= middle.time / 1000)
          )
            hi = x;
          else lo = x;
        }
        return (lo + hi) / 2;
      };
      // Price/time coordinate API is public; canvas bounds are read solely by
      // this visual probe to map public coordinates into screenshot pixels.
      const bounds = [
        ...document
          .querySelector("iframe")
          .contentDocument.querySelectorAll("canvas"),
      ]
        .map((c) => c.getBoundingClientRect())
        .filter((r) => r.width > 300 && r.height > 100)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      await probeAdapter.create({
        chart,
        object: { type: "shape", id: trend },
      });
      return {
        expectedX: bounds.left + (boundary(false) + boundary(true)) / 2,
        top: bounds.top,
        height: bounds.height,
        context: probeMessages
          .filter((m) => m.type === "chart-alert-context")
          .at(-1).context,
      };
    });
    await page.waitForTimeout(150);
    const logShot = output.replace(/\.json$/, ".log-geometry.png");
    await page.screenshot({ path: logShot });
    const logPixels = JSON.parse(
      execFileSync(
        "python",
        [
          "-c",
          `
import json,sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB'); x=round(float(sys.argv[2])); top=int(float(sys.argv[3])); bottom=top+int(float(sys.argv[4]))
def ys(color):
    return [y for y in range(top,bottom) for xx in range(x-2,x+3) if color(*im.getpixel((xx,y)))]
red=ys(lambda r,g,b:r>220 and g<40 and b<40)
blue=ys(lambda r,g,b:b>220 and r<40 and g<40)
assert red and blue, 'must observe the actual red log trend and blue 200-price reference at midpoint'
print(json.dumps(dict(red_y=sum(red)/len(red),blue_y=sum(blue)/len(blue))))
`,
          logShot,
          String(report.logGeometry.expectedX),
          String(report.logGeometry.top),
          String(report.logGeometry.height),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.ok(
      Math.abs(logPixels.red_y - logPixels.blue_y) < 4,
      "native log midpoint must equal geometric price 200",
    );
    assert.equal(report.logGeometry.context.line.scale, "log");
    report.logGeometry.pixels = logPixels;
    report.cases.push(
      "native log trend midpoint crosses geometric 200-price reference, not arithmetic 250",
    );
    await page.evaluate(() =>
      widget.activeChart().getPanes()[0].getMainSourcePriceScale().setMode(0),
    );
    await page.evaluate(() => {
      const chart = widget.activeChart(),
        shapes = chart.getAllShapes();
      for (const shape of shapes)
        chart.getShapeById(shape.id).setProperties({ visible: false });
      const reverse = shapes.filter((s) => s.name === "ray")[1];
      chart
        .getShapeById(reverse.id)
        .setProperties({ visible: true, linecolor: "#ff00ff", linewidth: 4 });
      chart
        .getPanes()[0]
        .getMainSourcePriceScale()
        .setVisiblePriceRange({ from: 70, to: 140 });
    });
    await page.waitForTimeout(100);
    await page.screenshot({
      path: output.replace(/\.json$/, ".reversed-ray.png"),
    });
    await page.screenshot({ path: output.replace(/\.json$/, ".png") });
    report.indicators = [];
    for (const name of ["SMA", "EMA", "RSI", "MACD"]) {
      const result = await page.evaluate(async (name) => {
        const chart = widget.activeChart(),
          meta = probeIndicatorFixture.catalog[name];
        const id = await chart.createStudy(
          "守望 Python " + name,
          false,
          false,
          meta.params,
        );
        let rendered;
        for (let i = 0; i < 100; i++) {
          rendered = probeRenderedIndicators[name];
          if (
            rendered?.[probeBars.at(-1).time]?.some((v) => Number.isFinite(v))
          )
            break;
          await new Promise((r) => setTimeout(r, 30));
        }
        await probeAdapter.create({ chart, object: { type: "study", id } });
        const snapshot = probeMessages
          .filter((m) => m.type === "chart-alert-context")
          .at(-1).context;
        return { name, id, rendered, snapshot };
      }, name);
      assert.equal(result.snapshot.indicator.name, name);
      let compared = 0;
      for (const [time, values] of Object.entries(result.rendered || {})) {
        const points = Object.values(indicatorFixture.outputs[name])[0],
          index = points.findIndex((p) => p.time === Number(time));
        if (index < 0) continue;
        const expected = Object.values(indicatorFixture.expected[name]).map(
          (series) => series[index],
        );
        assert.deepEqual(
          values,
          expected,
          name + " native study outputs must match alert values at " + time,
        );
        compared++;
      }
      assert.ok(
        compared >= 35,
        name + " must validate actual plotted values across the visible range",
      );
      assert.deepEqual(
        result.rendered[
          String(Object.values(indicatorFixture.outputs[name])[0].at(-1).time)
        ],
        Object.values(indicatorFixture.expected[name]).map((series) =>
          series.at(-1),
        ),
        name + " temporary last candle",
      );
      result.compared = compared;
      report.indicators.push(result);
    }
    report.cases.push(
      "four actual native custom studies return alert-identical values including provisional last candle",
    );
    report.multiChart = await page.evaluate(async () => {
      widget.setLayout("2h");
      for (
        let i = 0;
        i < 100 && (widget.chartsCount() !== 2 || !widget.chart(1).dataReady());
        i++
      )
        await new Promise((r) => setTimeout(r, 30));
      if (widget.chartsCount() !== 2)
        throw Error("actual native two-chart layout unavailable");
      probeAdapter.refresh();
      await probeAdapter.create({ chart: widget.chart(0), price: 100 });
      const first = probeMessages
        .filter((m) => m.type === "chart-alert-context")
        .at(-1).context;
      await probeAdapter.create({ chart: widget.chart(1), price: 110 });
      const second = probeMessages
        .filter((m) => m.type === "chart-alert-context")
        .at(-1).context;
      await new Promise((ok) => widget.chart(1).setSymbol("ETHUSDT", ok));
      await probeAdapter.create({ chart: widget.chart(1), price: 120 });
      const switched = probeMessages
        .filter((m) => m.type === "chart-alert-context")
        .at(-1).context;
      return { first, second, switched };
    });
    assert.notEqual(
      report.multiChart.first.association.chart_id,
      report.multiChart.second.association.chart_id,
    );
    assert.equal(report.multiChart.second.association.chart_index, 1);
    assert.equal(report.multiChart.switched.instrument, "ETHUSDT");
    assert.equal(
      report.multiChart.switched.association.chart_id,
      report.multiChart.second.association.chart_id,
    );
    assert.notEqual(
      report.multiChart.switched.association.generation,
      report.multiChart.second.association.generation,
    );
    report.cases.push(
      "actual two-chart layout retains distinct business identities and fences symbol generations",
    );
    report.transitions = await page.evaluate(async () => {
      widget.setActiveChart(0);
      const chart = widget.chart(0);
      for (const study of chart.getAllStudies()) chart.removeEntity(study.id);
      probeWrites.length = 0;
      await new Promise((ok) => chart.setSymbol("ETHUSDT", ok));
      await new Promise((ok) => chart.setSymbol("BTCUSDT", ok));
      await new Promise((ok) => chart.setResolution("120", ok));
      await new Promise((ok) => chart.setResolution("60", ok));
      await new Promise((r) => setTimeout(r, 100));
      return {
        status: probeBackendRow.status,
        version: probeBackendRow.version,
        writes: probeWrites.filter((q) => ["edit", "lifecycle"].includes(q.op)),
      };
    });
    assert.equal(report.transitions.status, "active");
    assert.equal(report.transitions.version, 5);
    assert.deepEqual(report.transitions.writes, []);
    report.cases.push(
      "native symbol and interval round trips leave the saved alert active and unchanged",
    );
    await page.evaluate(async () => {
      const state = await new Promise((ok) => widget.save(ok));
      probeAdapter.persist(state);
      globalThis.probePersistedCharts = state._mwAlertCharts;
      probeAdapter.reset(state);
      widget.load(state);
    });
    await page.waitForFunction(
      () => !probeLoading && widget.chart(0).dataReady(),
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() =>
      probeAdapter.setRows([structuredClone(probeBackendRow)]),
    );
    await page.waitForFunction(
      () =>
        widget
          .chart(0)
          .getAllShapes()
          .some(
            (s) =>
              s.name === "horizontal_line" &&
              Number(
                widget.chart(0).getShapeById(s.id).getPoints()[0].price,
              ) ===
                Number(
                  probeBackendRow.config.condition.right.line.points[0].price,
                ),
          ),
      null,
      { timeout: 5000 },
    );
    report.layout = await page.evaluate(() => {
      const chart = widget.chart(0),
        price = Number(
          probeBackendRow.config.condition.right.line.points[0].price,
        );
      const shapes = chart
        .getAllShapes()
        .filter(
          (s) =>
            s.name === "horizontal_line" &&
            Number(chart.getShapeById(s.id).getPoints()[0].price) === price,
        );
      globalThis.probeDragId = shapes[0].id;
      return {
        status: probeBackendRow.status,
        version: probeBackendRow.version,
        restoredCount: shapes.length,
        identities: probeAdapter.diagnostics().charts,
        savedIdentities: probePersistedCharts,
        writes: probeWrites.filter((q) => ["edit", "lifecycle"].includes(q.op)),
      };
    });
    assert.equal(report.layout.status, "active");
    assert.equal(report.layout.version, 5);
    assert.equal(report.layout.restoredCount, 1);
    assert.deepEqual(report.layout.identities, report.layout.savedIdentities);
    assert.deepEqual(report.layout.writes, []);
    report.cases.push(
      "native saved-layout reload restores chart identities and one backend drawing without writes or pauses",
    );
    report.deletion = await page.evaluate(async () => {
      widget.setActiveChart(0);
      const chart = widget.chart(0);
      chart.removeEntity(probeDragId);
      for (let i = 0; i < 100 && probeBackendRow.status !== "paused"; i++)
        await new Promise((r) => setTimeout(r, 20));
      return {
        status: probeBackendRow.status,
        reason: probeBackendRow.health_reason,
        lifecycle: probeWrites.filter((q) => q.op === "lifecycle"),
      };
    });
    assert.equal(report.deletion.status, "paused");
    assert.equal(report.deletion.lifecycle.length, 1);
    assert.equal(report.deletion.lifecycle[0].action, "drawing_deleted");
    // The keyboard must target the native iframe after the preceding API calls.
    await page
      .frames()
      .find((f) => f !== page.mainFrame())
      .locator("body")
      .press("Control+z");
    await page.waitForFunction(
      () =>
        widget
          .chart(0)
          .getAllShapes()
          .some((s) => s.id === probeDragId),
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => probeBackendRow.status), "paused");
    assert.equal(
      await page.evaluate(
        () => probeWrites.filter((q) => q.op === "lifecycle").length,
      ),
      1,
    );
    report.cases.push(
      "native explicit deletion pauses once; undo restores the drawing without resuming the alert",
    );
    report.errors = errors;
    assert.deepEqual(errors, []);
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        cases: report.cases,
        shapes: report.geometry.shapes,
        measuredStepCount: report.geometry.measuredStepCount,
        output,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
