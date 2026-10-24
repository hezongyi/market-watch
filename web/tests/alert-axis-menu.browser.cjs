// Licensed chart menu with synthetic data/API; no deployed instance writes.
const { chromium } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const library = process.env.MW_PROBE_LIBRARY,
  output = process.env.MW_PROBE_OUTPUT;
if (!library || !output)
  throw Error("Set MW_PROBE_LIBRARY and MW_PROBE_OUTPUT");
const probe = fs.readFileSync(
  path.join(__dirname, "native-alert-shell.probe.cjs"),
  "utf8",
);
const feed = probe
  .match(/const fixture = `([\s\S]*?)`;/)[1]
  .replace(
    "container:'chart',",
    "container:'chart',context_menu:{items_processor:(items,factory,params)=>{globalThis.menuParams=params;return bridge.menu(items,factory,params)}},",
  );
const fixture =
  feed +
  `
globalThis.writes=[];globalThis.notes=[];globalThis.rows=[];
widget.onChartReady(async()=>{
 widget.subscribe('onPlusClick',p=>globalThis.plusEvent=p);
 globalThis.bridge=chartAlertBridge({getWidget:()=>widget,getWorkspace:()=>({id:'fixture'}),getEpoch:()=>1,isLoading:()=>false,readonly:false,metadata:()=>({source:'fixture',basis:'bid'}),frames:{60:'H1'},rpc:async()=>{},send:m=>{if(m.type==='chart-alert-context')ui.context(m.context)},fail:e=>notes.push(String(e))});bridge.attach();
 const request=async q=>{
  if(q.body){writes.push(q);if(q.path.endsWith('capabilities'))return {sources:[{source:'fixture',series_kind:'managed',available:true,atr_frames:['H1']}]};
   if(q.path==='/chart-alerts'){const config=q.body.config;const row={id:q.body.request_id,name:config.name,config,version:1,control_revision:1,run:1,status:'active',health:'ready',count:0,max_triggers:1,created_at:Date.now(),updated_at:Date.now(),effective_at:Date.now(),condition_summary:config.name,runtime:{}};rows.push(row);return structuredClone(row);}}
  return structuredClone(q.path.endsWith('events')?[]:rows);
 };
 globalThis.ui=await MWNativeAlerts.attach({widget,scope:{workspace_id:'fixture',session:'fixture'},readonly:false,request,bridge,report:e=>notes.push(String(e))});ui.theme('dark');globalThis.testReady=true;
});
`;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const assets = path.join(output, "ui-assets");
  execFileSync(process.execPath, ["scripts/build-alert-ui.mjs", assets], {
    cwd: path.join(root, "web"),
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
  });
  const report = {
    scope:
      "Current source + licensed chart, synthetic feed/API; no instance changes",
    passed: false,
    cases: [],
    errors: [],
  };
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.route("https://alert-axis-menu.invalid/**", (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/")
      return r.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          '<!doctype html><meta charset="utf-8"><style>html,body,#chart{height:100%;margin:0}</style><div id="chart"></div>' +
          [
            "/charting_library/charting_library.js",
            "/series.js",
            "/price-format.js",
            "/chart-alerts.js",
            "/native-alert-shell.js",
            "/alert-ui.js",
            "/fixture.js",
          ]
            .map((s) => '<script src="' + s + '"></script>')
            .join(""),
      });
    if (p === "/fixture.js")
      return r.fulfill({ contentType: "text/javascript; charset=utf-8", body: fixture });
    const file = p.startsWith("/charting_library/")
      ? path.resolve(library, p.slice(18))
      : path.join(
          /^\/alert-ui\.(js|css)$/.test(p)
            ? assets
            : path.join(root, "advanced-host"),
          path.basename(p),
        );
    return fs.existsSync(file)
      ? r.fulfill({
          path: file,
          ...(file.endsWith(".js")
            ? { contentType: "text/javascript; charset=utf-8" }
            : file.endsWith(".css")
              ? { contentType: "text/css" }
              : {}),
        })
      : r.fulfill({ status: 404 });
  });
  try {
    await page.goto("https://alert-axis-menu.invalid/");
    await page.waitForFunction(
      () => globalThis.testReady && widget.activeChart().dataReady(),
    );
    const chart = page.frames().find((f) => f !== page.mainFrame());
    async function plus(ratio = 0.52) {
      const b = await page.evaluate(() =>
        widget
          .activeChart()
          ._chartWidget.paneWidgets()
          .find((p) => p.containsMainSeries())
          .canvasElement()
          .getBoundingClientRect()
          .toJSON(),
      );
      await page.mouse.move(b.right - 60, b.y + b.height * ratio);
      await page.mouse.move(b.right - 9, b.y + b.height * ratio);
      await page.waitForTimeout(250);
      await page.mouse.click(b.right - 9, b.y + b.height * ratio);
      const create = chart.getByText(/^在 .* 创建告警$/, { exact: true });
      await create.waitFor();
      return create;
    }
    const dismissed = await plus();
    assert.equal(
      await page.evaluate(
        () => writes.filter((q) => q.path === "/chart-alerts").length,
      ),
      0,
      "plus only opens selection",
    );
    assert.equal(
      await chart.locator('[data-name="mw-native-alert-dialog"]').count(),
      0,
    );
    await page.screenshot({ path: path.join(output, "plus-selection.png") });
    await page.keyboard.press("Escape");
    await dismissed.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(
        () => writes.filter((q) => q.path === "/chart-alerts").length,
      ),
      0,
      "dismiss never creates",
    );
    const create = await plus(0.62),
      text = await create.innerText();
    await create.click();
    await page.waitForFunction(() =>
      writes.some((q) => q.path === "/chart-alerts"),
    );
    const posted = await page.evaluate(() =>
      writes.filter((q) => q.path === "/chart-alerts"),
    );
    assert.equal(posted.length, 1);
    assert.ok(text.includes(posted[0].body.config.condition.right.value));
    assert.equal(posted[0].body.config.condition.relation, "cross_up");
    assert.equal(posted[0].body.config.notify_ntfy, false);
    assert.equal(
      await chart.locator('[data-name="mw-native-alert-dialog"]').count(),
      0,
      "selection creates without price editor",
    );
    await page.screenshot({ path: path.join(output, "selected-created.png") });
    report.cases.push(
      "Native plus opens menu without creation; Escape dismisses without creation; choosing alert creates exactly once at captured price without editor",
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (e) {
    report.failure = String(e);
    report.fixture = await page.evaluate(()=>({plus:globalThis.plusEvent,menu:globalThis.menuParams,notes:globalThis.notes}));
    await page.screenshot({ path: path.join(output, "failure.png") });
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
