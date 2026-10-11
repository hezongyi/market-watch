// Real licensed widget + shipped adapters/React renderer, isolated origins, synthetic parent API.
const { chromium } = require(process.env.MW_PLAYWRIGHT || "@playwright/test");
const { build } = require("esbuild");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.."),
  library = process.env.MW_PROBE_LIBRARY;
const output =
  process.env.MW_PROBE_OUTPUT || "/tmp/mw-native-alert-ui-integration";
if (!library)
  throw Error("MW_PROBE_LIBRARY must identify the private library directory");
const fixture = `
const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['60'],supports_marks:false,supports_timescale_marks:false}),0),resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'forex',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,supported_resolutions:['60']}),0),getBars:(s,r,p,cb)=>setTimeout(()=>{const bars=[];for(let n=p.countBack;n>0;n--){bars.push({time:(Math.floor(p.to/3600)-n)*3600000,open:1.121+Math.sin(n/7)*0.003,high:1.1215+Math.sin(n/7)*0.003,low:1.1205+Math.sin(n/7)*0.003,close:1.121+Math.sin((n+1)/7)*0.003});}cb(bars,{noData:false});},0),subscribeBars:()=>{},unsubscribeBars:()=>{},getQuotes:(symbols,cb)=>cb(symbols.map(n=>({n,s:'ok',v:{lp:1.12,ch:0,chp:0,short_name:n,exchange:'Fixture'}}))),subscribeQuotes:()=>{},unsubscribeQuotes:()=>{}};
const scope={workspace_id:'fixture',session:'fixture-session'};
let seq=0;const pending=new Map();
const send=message=>parent.postMessage({channel:'mw-chart-v1',...message},'https://alert-parent.invalid');
const request=query=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});send({type:'chart-alert-ui-rpc',id,query});});
addEventListener('message',event=>{if(event.source!==parent||event.origin!=='https://alert-parent.invalid'||event.data?.channel!=='mw-chart-v1')return;const m=event.data;if(m.type==='result'){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Object.assign(Error(m.error),m.errorDetails)):p?.resolve(m.result);}if(m.type==='chart-alert-ui-context')ui.context(m.context);});
globalThis.widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,symbol:'EURUSD',interval:'60',locale:'zh',autosize:true,theme:'Dark',enabled_features:['support_multicharts'],context_menu:{items_processor:(items,factory,params)=>bridge.menu(items,factory,params)},widgetbar:{watchlist:true,details:true,datawindow:true,watchlist_settings:{default_symbols:['EURUSD']}},disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default']});
let epoch=1,loading=false;
const bridge=chartAlertBridge({getWidget:()=>widget,getWorkspace:()=>({id:'fixture'}),getEpoch:()=>epoch,isLoading:()=>loading,readonly:false,metadata:()=>({source:'fixture'}),frames:{60:'H1'},rpc:async q=>q.op==='geometry'?{...q.args,mapping_version:'bar-index-v1',points:q.args.points.map((point,index)=>({...point,index}))}:{},send,fail:error=>send({type:'fixture-error',error:String(error)})});
widget.onChartReady(async()=>{bridge.attach();globalThis.ui=await MWNativeAlerts.attach({widget,scope,readonly:false,request,bridge,report:error=>send({type:'fixture-error',error:String(error)})});ui.theme('dark');ui.open();globalThis.ready=true;});
`;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const uiAssets = path.join(output, "ui-assets");
  execFileSync(process.execPath, ["scripts/build-alert-ui.mjs", uiAssets], {
    cwd: path.join(root, "web"),
  });
  const parentBundle = await build({
    stdin: {
      contents: `import {chartAlertUiRequest} from './src/advanced/chartAlertUiApi';import {api,setCsrf} from './src/api';import {validAlertContext} from './src/advanced/chartAlerts';setCsrf('parent-only-secret');globalThis.calls=[];globalThis.fixtureErrors=[];addEventListener('message',async event=>{const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow||event.origin!=='https://alert-chart.invalid'||event.data?.channel!=='mw-chart-v1')return;const m=event.data;const reply=value=>frame.contentWindow.postMessage({channel:'mw-chart-v1',...value},'https://alert-chart.invalid');if(m.type==='chart-alert-context'&&validAlertContext(m.context,'fixture'))reply({type:'chart-alert-ui-context',context:m.context});if(m.type==='fixture-error')fixtureErrors.push(m.error);if(m.type==='chart-alert-ui-rpc'){calls.push(m.query);try{const result=await chartAlertUiRequest(m.query,{workspace_id:'fixture',session:'fixture-session'},()=>true,api);reply({type:'result',id:m.id,result});}catch(e){reply({type:'result',id:m.id,error:String(e),errorDetails:{status:e.status,code:e.code}});}}});`,
      resolveDir: path.join(root, "web"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 2744, height: 890 },
  });
  const report = {
      scope:
        "Ubuntu Chromium, actual widget and shipped UI, cross-origin parent API fixture; no deployed instance",
      cases: [],
      errors: [],
    },
    writes = [],
    rows = [],
    events = [];
  let rejectCreate = true;
  let rejectGeometry = false;
  let releaseCreate;
  const heldCreate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  page.on("pageerror", (e) => {
    report.errors.push(String(e));
    console.log(e.stack);
  });
  await page.route("https://alert-parent.invalid/**", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts allow-same-origin" allow="fullscreen" allowfullscreen src="https://alert-chart.invalid/"></iframe><script src="/parent.js"></script></body></html>',
      });
    if (u.pathname === "/parent.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: parentBundle.outputFiles[0].text,
      });
    const body = req.method() === "POST" ? req.postDataJSON() : undefined;
    if (body)
      writes.push({
        path: u.pathname,
        body,
        csrf: req.headers()["x-csrf-token"],
      });
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (u.pathname === "/api/chart-alerts/capabilities")
      return reply({
        sources: [
          {
            source: "fixture",
            series_kind: "managed",
            basis: "last",
            available: true,
            reason: null,
            observation_basis: "抽样当前收盘值",
          },
        ],
        modes: ["close", "intrabar"],
        indicators: ["SMA", "EMA", "RSI", "MACD"],
      });
    if (u.pathname === "/api/chart-alerts/geometry") {
      if (rejectGeometry) {
        rejectGeometry = false;
        return reply({ detail: "画线端点未匹配实际 K 线" }, 422);
      }
      assert.ok(
        body.points.every(
          (point) => Object.keys(point).sort().join() === "price,time",
        ),
      );
      const step = body.timeframe === "H4" ? 14_400_000 : 3_600_000;
      return reply({
        kind: body.kind,
        scale: body.scale,
        extend_left: body.extend_left,
        extend_right: body.extend_right,
        mapping_version: "bar-index-v1",
        points: body.points.map((point) => ({
          ...point,
          index: (point.time - body.points[0].time) / step,
        })),
      });
    }
    if (u.pathname === "/api/chart-alerts/events") return reply(events);
    if (u.pathname === "/api/chart-alerts" && req.method() === "GET")
      return reply(rows.filter((row) => row.status !== "archived"));
    if (u.pathname === "/api/chart-alerts") {
      if (rejectCreate) {
        await heldCreate;
        rejectCreate = false;
        return reply({ detail: "保存失败，请重试" }, 503);
      }
      const row = {
        id: crypto.randomUUID(),
        name: body.config.name,
        version: 1,
        control_revision: 1,
        run: 1,
        status: "active",
        health: "warming",
        health_reason: "等待行情",
        count: 0,
        max_triggers: body.config.max_triggers,
        effective_at: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
        config: body.config,
        condition_summary: "价格 上穿 1.121",
        runtime: {},
      };
      rows.push(row);
      return reply(row, 201);
    }
    const id = u.pathname.split("/")[3],
      row = rows.find((row) => row.id === id);
    if (u.pathname.endsWith("/edit")) {
      row.config = body.config;
      row.name = body.config.name;
      row.version++;
      return reply(row);
    }
    if (u.pathname.endsWith("/lifecycle")) {
      row.status = {
        pause: "paused",
        resume: "active",
        restart: "active",
        archive: "archived",
        rebaseline: "active",
      }[body.action];
      row.control_revision++;
      return reply(row);
    }
    if (u.pathname.endsWith("/ack")) {
      events[0].ack_at = Date.now();
      return reply({ ok: true });
    }
    return reply({ detail: "Unexpected fixture request" }, 404);
  });
  await page.route("https://alert-chart.invalid/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'none'",
        },
        body: '<!doctype html><html><head><meta charset="utf-8"><style>html,body,#chart{margin:0;height:100%}</style></head><body><div id="chart"></div><script src="/charting_library/charting_library.js"></script><script src="/series.js"></script><script src="/chart-alerts.js"></script><script src="/native-alert-shell.js"></script><script src="/alert-ui.js"></script><script src="/fixture.js"></script></body></html>',
      });
    if (u.pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: fixture });
    const file = u.pathname.startsWith("/charting_library/")
      ? path.resolve(library, u.pathname.slice("/charting_library/".length))
      : path.join(
          /^\/alert-ui\.(js|css)$/.test(u.pathname)
            ? uiAssets
            : path.join(root, "advanced-host"),
          path.basename(u.pathname),
        );
    if (!fs.existsSync(file))
      return route.fulfill({ status: 404, body: "Fixture asset missing" });
    return route.fulfill({
      path: file,
      ...(file.endsWith(".js")
        ? { contentType: "text/javascript; charset=utf-8" }
        : file.endsWith(".css")
          ? { contentType: "text/css" }
          : {}),
    });
  });
  try {
    await page.goto("https://alert-parent.invalid/");
    const host = page
      .frames()
      .find((frame) => frame.url() === "https://alert-chart.invalid/");
    await host.waitForFunction(() => globalThis.ready);

    const chart = page
      .frames()
      .find((frame) => frame !== host && frame !== page.mainFrame());
    await host.waitForFunction(() => widget.activeChart().dataReady());
    await chart
      .locator('[data-qa-id="pane-top-canvas"]')
      .first()
      .click({ button: "right", position: { x: 400, y: 40 } });
    await chart.getByText(/创建(?:主价格系列|价格)告警/).waitFor();
    await page.screenshot({
      path: path.join(output, "context-native-menu.png"),
    });
    await page.keyboard.press("Escape");
    await chart
      .getByRole("button", { name: "创建告警", exact: true })
      .first()
      .click();
    await chart
      .locator('[data-name="mw-native-alert-dialog"]')
      .waitFor({ state: "visible" });
    await chart
      .locator('[data-name="mw-native-alert-dialog"]')
      .getByRole("button", { name: "创建告警", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(output, "create-initial.png") });
    const dialog = chart.locator('[data-name="mw-native-alert-dialog"]');
    report.reuse = await dialog
      .locator("[data-native-control]")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          kind: node.dataset.nativeControl,
          nativeClass: node.firstElementChild?.className,
        })),
      );
    report.geometry = await dialog.evaluate((node) => ({
      shell: node.getBoundingClientRect().toJSON(),
      body: node
        .querySelector(".chart-alert-dialog")
        .getBoundingClientRect()
        .toJSON(),
      controls: [
        ...node.querySelectorAll(
          ".alert-condition-fields [data-native-control]",
        ),
      ].map((n) => n.getBoundingClientRect().toJSON()),
      select: [
        ...node.querySelector(".mw-native-select").querySelectorAll("*"),
      ].map((n) => ({
        tag: n.tagName,
        className: n.className,
        align: getComputedStyle(n).textAlign,
        justify: getComputedStyle(n).justifyContent,
      })),
    }));
    await dialog.getByRole("button", { name: "关系", exact: true }).click();
    await page.screenshot({
      path: path.join(output, "condition-native-menu.png"),
    });
    await chart.getByRole("option", { name: "高于", exact: true }).click();
    await dialog.getByRole("button", { name: "关系", exact: true }).click();
    await chart.getByRole("option", { name: "上穿", exact: true }).click();
    await chart.getByLabel("比较值", { exact: true }).fill("1.121");
    await dialog.getByRole("button", { name: "到期时间", exact: true }).click();
    await page.screenshot({
      path: path.join(output, "expiry-native-menu.png"),
    });
    await chart
      .getByRole("menuitemcheckbox", { name: "不限", exact: true })
      .click();
    await dialog.getByRole("button", { name: "消息", exact: false }).click();
    await dialog.getByLabel("警报名称").fill("欧元突破");
    await dialog.getByLabel("消息正文").fill("观察 {symbol}");
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    await chart.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "消息",
    );
    assert.equal(
      writes.filter((write) => write.path === "/api/chart-alerts").length,
      0,
    );
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    await dialog.getByLabel("消息正文").fill("取消的正文");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await chart.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "消息",
    );
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("消息正文").inputValue(),
      "观察 {symbol}",
    );
    await page.screenshot({ path: path.join(output, "message-dark.png") });
    await dialog.getByRole("button", { name: "返回", exact: true }).click();
    await chart.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "消息",
    );
    await dialog.getByRole("button", { name: "通知", exact: true }).click();
    await dialog.getByLabel("已有 ntfy 推送通道").click();
    await chart.waitForFunction(() =>
      document
        .querySelector(".mw-native-checkbox input")
        ?.parentElement.parentElement.textContent.includes("网页"),
    );
    await dialog.getByLabel("已有 ntfy 推送通道").waitFor();
    await page.screenshot({
      path: path.join(output, "notifications-dark.png"),
    });
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    await chart.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "通知",
    );
    await dialog.getByRole("button", { name: "触发次数", exact: true }).click();
    await page.screenshot({
      path: path.join(output, "trigger-native-menu.png"),
    });
    await chart.getByRole("option", { name: "最多 2 次", exact: true }).click();
    report.cases.push(
      "Message and notification subpages apply only to draft; cancel/reentry restores values; finite trigger semantics",
    );
    await chart
      .locator('[data-name="mw-native-alert-dialog"]')
      .getByRole("button", { name: "创建告警", exact: true })
      .click();
    await chart.waitForFunction(
      () =>
        document
          .querySelector('.mw-native-select [role="button"]')
          ?.getAttribute("aria-disabled") === "true",
    );
    assert.equal(
      await dialog.getByLabel("比较值", { exact: true }).isDisabled(),
      true,
    );
    releaseCreate();
    await chart.getByRole("alert").filter({ hasText: "保存失败" }).waitFor();
    assert.equal(
      await chart.getByLabel("比较值", { exact: true }).inputValue(),
      "1.121",
    );
    await chart
      .locator('[data-name="mw-native-alert-dialog"]')
      .getByRole("button", { name: "创建告警", exact: true })
      .click();
    await chart
      .locator('[data-name="mw-native-alert-dialog"]')
      .waitFor({ state: "detached" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].config.notify_ntfy, true);
    assert.equal(rows[0].config.max_triggers, 2);
    assert.ok(writes.every((write) => write.csrf === "parent-only-secret"));
    report.cases.push(
      "Native shell renders shipped form; failed save retains draft; parent owns every API write and CSRF",
    );
    await page.screenshot({ path: path.join(output, "sidebar-dark.png") });
    await chart.locator(".chart-alert-card .alert-row-summary").hover();
    await page.screenshot({ path: path.join(output, "sidebar-hover.png") });
    await chart.getByRole("button", { name: "暂停", exact: true }).click();
    await chart.getByRole("button", { name: "恢复", exact: true }).waitFor();
    await chart.getByRole("button", { name: "恢复", exact: true }).click();
    await chart.getByRole("button", { name: "暂停", exact: true }).waitFor();
    await chart.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.waitFor();
    await page.screenshot({ path: path.join(output, "edit-dark.png") });
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    await dialog.getByLabel("警报名称").fill("已编辑");
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    await dialog.getByRole("button", { name: "保存新版本" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(rows[0].version, 2);
    report.cases.push(
      "Pause/resume and edit use existing version/control revision API",
    );
    await chart.getByRole("button", { name: "排序", exact: true }).click();
    await page.screenshot({ path: path.join(output, "sort-native-menu.png") });
    await page.keyboard.press("End");
    assert.equal(
      await chart.evaluate(() => document.activeElement.textContent.trim()),
      "名称",
    );
    await page.keyboard.press("Home");
    assert.equal(
      await chart.evaluate(() => document.activeElement.textContent.trim()),
      "创建时间",
    );
    await chart
      .getByRole("menuitemcheckbox", { name: "名称", exact: true })
      .click();
    await chart.getByRole("button", { name: "更多选项", exact: true }).click();
    await page.screenshot({ path: path.join(output, "more-native-menu.png") });
    await page.keyboard.press("Escape");
    await chart.getByRole("button", { name: "搜索告警" }).click();
    await chart.getByLabel("搜索", { exact: true }).fill("不存在");
    await chart.getByText("没有符合筛选条件的警报", { exact: true }).waitFor();
    await chart.getByLabel("搜索", { exact: true }).fill("已编辑");
    await chart.locator(".chart-alert-card").waitFor();
    await page.screenshot({ path: path.join(output, "search-dark.png") });
    const before = await host.evaluate(async () => {
      const b = (await widget.widgetbar())._widgetbar;
      return b.resizerBridge.width.value();
    });
    const handle = await chart.locator(".widgetbar-handle").boundingBox();
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(handle.x - 80, handle.y + handle.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    const after = await host.evaluate(async () => {
      const b = (await widget.widgetbar())._widgetbar;
      return b.resizerBridge.width.value();
    });
    assert.ok(after - before > 40);
    await host.evaluate(async () => {
      const b = (await widget.widgetbar())._widgetbar;
      b.refreshFromTVSettings();
      b.setPage("alerts");
    });
    assert.equal(
      await chart.locator('[data-name="mw-native-alert-content"]').count(),
      1,
    );
    assert.equal(
      await chart.getByLabel("搜索", { exact: true }).inputValue(),
      "已编辑",
    );
    await chart.getByRole("button", { name: "关闭搜索" }).click();
    await host.evaluate(async () => {
      const b = await widget.widgetbar();
      b.showPage("object_tree");
    });
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "hidden" });
    await host.evaluate(() => ui.open());
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "visible" });
    report.cases.push(
      "Native drag reallocates chart width; native page rebuild retains search state and one mounted renderer; object tree round trip",
    );
    events.push({
      id: crypto.randomUUID(),
      alert_id: rows[0].id,
      occurred_at: Date.now(),
      detected_at: Date.now(),
      price: "1.125",
      threshold: "1.121",
      notification_id: crypto.randomUUID(),
      notification_status: "pending",
      delivery_status: "pending",
      ack_at: null,
      message: "观察 EURUSD",
      evidence: {
        config: rows[0].config,
        left: "1.125",
        rule_version: 2,
        ordinal: 1,
        late: true,
        observation: { sample: "fixture" },
      },
    });
    await chart.getByRole("tab", { name: "日志", exact: true }).click();
    await chart.locator(".alert-event-day").waitFor({ timeout: 8000 });
    await page.screenshot({ path: path.join(output, "log-compact.png") });
    await chart.getByRole("button", { name: "更多选项", exact: true }).click();
    await page.screenshot({ path: path.join(output, "log-native-menu.png") });
    await page.keyboard.press("Escape");
    await chart.locator(".alert-event-day .alert-row-summary").click();
    await chart.getByRole("button", { name: "确认此事件" }).click();
    await chart.getByRole("button", { name: "已确认", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "log-dark.png") });
    report.cases.push(
      "Date-grouped log retains late evidence, rule version, delivery status and independent acknowledgement",
    );
    await chart.getByRole("tab", { name: "警报", exact: true }).click();
    await chart.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    await page.keyboard.press("Escape");
    await dialog.getByLabel("比较值", { exact: true }).waitFor();
    await chart.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "消息",
    );
    await dialog.getByRole("button", { name: "通知", exact: true }).click();
    await page.keyboard.press("Escape");
    await chart.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "通知",
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await chart.evaluate(
        () =>
          document.activeElement.closest(
            '[data-name="mw-native-alert-dialog"]',
          ) !== null,
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await host.evaluate(async () => {
      await widget.changeTheme("Light");
      ui.theme("Light");
    });
    await page.screenshot({ path: path.join(output, "sidebar-light.png") });
    await chart.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.waitFor();
    await page.screenshot({ path: path.join(output, "edit-light.png") });
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await dialog.waitFor({ state: "detached" });
    report.cases.push(
      "Escape returns from subpage, modal focus stays inside native shell, final Escape closes; light theme applies",
    );
    const tabButton = chart
      .locator(".widgetbar-tabs")
      .getByRole("button", { name: "警报", exact: true });
    report.nativeTabs = await chart
      .locator(".widgetbar-tabs button")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          page: node.dataset.name,
          label: node.getAttribute("aria-label"),
        })),
      );
    await tabButton.click();
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "hidden" });
    await tabButton.click();
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "visible" });
    await tabButton.focus();
    await page.keyboard.press("Enter");
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "hidden" });
    await page.keyboard.press("Enter");
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "visible" });
    report.cases.push(
      "Native sidebar tab toggles with real mouse and keyboard; native menus handle Home/End/Escape",
    );
    await page.setViewportSize({ width: 760, height: 720 });
    await host.evaluate(() => ui.open());
    await chart.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 760);
    await page.screenshot({ path: path.join(output, "edit-narrow.png") });
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await page.setViewportSize({ width: 2744, height: 890 });
    await host.evaluate(async () => {
      await widget.changeTheme("Dark");
      ui.theme("Dark");
    });
    const choose = async (label, option) => {
      await dialog.getByRole("button", { name: label, exact: true }).click();
      await chart.getByRole("option", { name: option, exact: true }).click();
    };
    const create = async () => {
      await chart
        .getByRole("button", { name: "创建告警", exact: true })
        .first()
        .click();
      await dialog.waitFor();
    };
    await create();
    await choose("关系", "进入价格区间");
    await dialog.getByLabel("下限", { exact: true }).fill("1.115");
    await dialog.getByLabel("上限", { exact: true }).fill("1.125");
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(rows.at(-1).config.condition.relation, "enter");
    assert.equal(rows.at(-1).config.condition.lower, "1.115");
    await create();
    await choose("条件", "指标输出");
    await dialog
      .locator(".alert-advanced-options")
      .evaluate((node) => (node.open = true));
    await choose("比较目标", "指标输出");
    await dialog
      .locator(".alert-indicator-fields")
      .nth(1)
      .getByRole("button", { name: "指标", exact: true })
      .click();
    await chart.getByRole("option", { name: "EMA", exact: true }).click();
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(rows.at(-1).config.condition.left.indicator.name, "SMA");
    assert.equal(rows.at(-1).config.condition.right.indicator.name, "EMA");
    await host.evaluate(async () => {
      const chart = widget.activeChart(),
        id = await chart.createShape(
          { time: chart.getVisibleRange().to - 3600, price: 1.125 },
          { shape: "horizontal_line" },
        );
      await bridge.create({ chart, object: { type: "shape", id } });
    });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      rows.at(-1).config.condition.right.line.kind,
      "horizontal_line",
    );
    report.cases.push(
      "Real native controls preserve range, two indicator operands and drawing snapshot creation",
    );
    await host.evaluate(() =>
      ui.context({
        request_id: crypto.randomUUID(),
        instrument: "EURUSD",
        series_kind: "managed",
        source: "fixture",
        timeframe: "H1",
        published: true,
        association: {
          workspace_id: "fixture",
          chart_id: "chart-0",
          chart_index: 0,
          generation: "1:0",
          object_id: "trend-0",
          object_kind: "drawing",
        },
        line: {
          kind: "trend_line",
          scale: "linear",
          extend_left: false,
          extend_right: true,
          mapping_version: "bar-index-v1",
          points: [
            { time: 1_800_000_000_000, price: "1.12", index: 0 },
            { time: 1_800_014_400_000, price: "1.13", index: 4 },
          ],
        },
      }),
    );
    await dialog.waitFor();
    await dialog
      .locator(".alert-advanced-options")
      .evaluate((node) => (node.open = true));
    await choose("判定周期", "H4");
    rejectGeometry = true;
    const beforeLineSave = rows.length;
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.getByText(/画线端点未匹配实际 K 线/).waitFor();
    assert.equal(
      rows.length,
      beforeLineSave,
      "Failed remapping must not save a rule",
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "判定周期", exact: true })
        .textContent(),
      "H4",
    );
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(rows.at(-1).config.timeframe, "H4");
    assert.deepEqual(
      rows
        .at(-1)
        .config.condition.right.line.points.map((point) => point.index),
      [0, 1],
    );
    assert.equal(rows.at(-1).config.association, null);
    report.remappedConfig = rows.at(-1).config;
    report.cases.push(
      "Drawing timeframe change remaps endpoints before save; mapping failure retains the draft and prevents writes",
    );
    const primary = chart
      .locator(".chart-alert-card")
      .filter({ hasText: "已编辑" });
    const beforeCopy = rows.length;
    await primary.getByRole("button", { name: /行操作/ }).click();
    await chart
      .getByRole("menuitem", { name: "复制为草稿", exact: true })
      .click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    assert.match(await dialog.getByLabel("警报名称").inputValue(), /副本$/);
    assert.equal(rows.length, beforeCopy);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await host.evaluate(async () => {
      widget.setLayout("2h");
    });
    await host.waitForFunction(
      () => widget.chartsCount() === 2 && widget.chart(1).dataReady(),
    );
    await host.evaluate(() => {
      bridge.refresh();
      widget.chart(1).setSymbol("GBPUSD");
      widget.setActiveChart(1);
    });
    await host.waitForFunction(
      () => widget.activeChart().symbol() === "GBPUSD",
    );
    await chart.getByRole("button", { name: "更多选项", exact: true }).click();
    await chart
      .getByRole("menuitemcheckbox", { name: "当前品种", exact: true })
      .click();
    await chart.getByText("没有符合筛选条件的警报", { exact: true }).waitFor();
    await host.evaluate(() => widget.setActiveChart(0));
    await primary.waitFor();
    await primary.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.waitFor();
    await host.evaluate(() => widget.setActiveChart(1));
    assert.match(await dialog.getAttribute("aria-label"), /EURUSD/);
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await host.evaluate(() => widget.setActiveChart(0));
    await primary.waitFor();
    await primary.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "删除告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(rows[0].status, "archived");
    report.cases.push(
      "Copy is draft only; current-symbol filter follows active pane while edit draft stays fixed; edit footer archives through existing lifecycle",
    );
    await chart.getByRole("button", { name: "全屏模式", exact: true }).click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.equal(await host.locator('[data-name="mw-alert-state"]').count(), 1);
    await host.evaluate(() => bridge.create());
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.evaluate(() => document.exitFullscreen());
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "visible" });
    report.cases.push(
      "Native fullscreen retains one renderer and permits dialog creation; exiting restores the native alert page",
    );
    await host.evaluate(() => ui.destroy());
    assert.equal(await host.locator('[data-name="mw-alert-state"]').count(), 0);
    const cleanup = await host.evaluate(async () => {
      const bar = (await widget.widgetbar())._widgetbar,
        doc = bar._wrap.ownerDocument,
        original = bar.getLayoutState;
      const runtime = nativeAlertRuntimes.get(doc),
        load = runtime.e;
      runtime.e = (id) =>
        id === 56595
          ? Promise.reject(Error("expected chunk failure"))
          : load(id);
      let failed = false;
      try {
        await nativeAlertShell(widget, {
          mount: () => {},
          unmount: () => {},
          report: () => {},
        });
      } catch {
        failed = true;
      } finally {
        runtime.e = load;
      }
      const restored = bar.getLayoutState === original;
      const shell = await nativeAlertShell(widget, {
        mount: () => {},
        unmount: () => {},
        report: () => {},
      });
      const opening = shell
        .openDialog({ title: "销毁中的窗口", onClose: () => {} })
        .catch(() => null);
      shell.destroy();
      await opening;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        failed,
        restored,
        stray: doc.querySelectorAll(
          '[data-name="mw-native-alert-dialog"],[data-name="warning-dialog"]',
        ).length,
      };
    });
    assert.deepEqual(cleanup, { failed: true, restored: true, stray: 0 });
    report.cleanup = cleanup;
    report.cases.push(
      "Failed chunk loading leaves native configuration intact; destruction cancels a pending native dialog without a stray window",
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(await page.evaluate(() => fixtureErrors), []);
    report.cases.push(
      "Narrow viewport retains bounded dialog; destruction removes business root",
    );
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = String(error);
    report.dialog = await page
      .frames()
      .find(
        (f) =>
          f !== page.mainFrame() && f.url() !== "https://alert-chart.invalid/",
      )
      .locator('[data-name="mw-native-alert-dialog"]')
      .evaluate((node) => ({
        html: node.outerHTML,
        rect: node.getBoundingClientRect().toJSON(),
      }))
      .catch(() => null);
    await page.screenshot({ path: path.join(output, "failure.png") });
    process.exitCode = 1;
  } finally {
    report.writes = writes.map(({ path, body }) => ({ path, body }));
    report.fixtureErrors = await page.evaluate(() => globalThis.fixtureErrors);
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          passed: report.passed,
          cases: report.cases,
          errors: report.errors,
          failure: report.failure,
        },
        null,
        2,
      ),
    );
    await browser.close();
  }
})();
