// Actual React components, in-process synthetic HTTP routes; no product instance.
const { chromium } = require("@playwright/test");
const { build } = require("esbuild");
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const output =
  process.env.CHART_ALERT_UI_OUTPUT ||
  "/tmp/mw-chart-alerts-acceptance/ui-probe.json";
(async () => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ChartAlertsPanel} from './src/advanced/ChartAlertsPanel';
    function Harness(){const [context,setContext]=React.useState(null),[theme,setTheme]=React.useState('dark');
      globalThis.setProbeTheme=setTheme;
      return <ChartAlertsPanel workspaceId="fixture" context={context} open theme={theme} readonly={false}
        associationNotices={{}} onClose={()=>{}} onRows={()=>{}} onLocate={()=>{}}
        onDrawingAction={()=>{}} onRequest={()=>setContext({request_id:crypto.randomUUID(),instrument:'BTCUSDT',source:'binance',series_kind:'managed',timeframe:'M1',price:'100',association:{workspace_id:'fixture',chart_id:'chart-one',generation:'1',object_id:null,object_kind:null}})} />;}
    createRoot(document.getElementById('root')).render(<Harness/>);`,
      resolveDir: path.resolve(__dirname, ".."),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: "probe",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const js = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text,
    css = bundle.outputFiles.find((f) => f.path.endsWith(".css")).text;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    }),
    errors = [],
    writes = [],
    report = {
      scope:
        "actual React components / synthetic routed API, no deployed instance",
      cases: [],
    };
  const rows = [],
    events = [];
  let rejectCreate = true;
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("https://chart-alert-ui.invalid/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/probe.css"></head><body><div id="root"></div><script src="/probe.js"></script></body></html>',
      });
    if (url.pathname === "/probe.js")
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (url.pathname === "/probe.css")
      return route.fulfill({ contentType: "text/css", body: css });
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    if (body) writes.push({ path: url.pathname, body });
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (url.pathname === "/api/chart-alerts/capabilities")
      return reply({
        sources: [
          {
            source: "binance",
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
    if (url.pathname === "/api/chart-alerts/events") return reply(events);
    if (url.pathname === "/api/chart-alerts" && request.method() === "GET")
      return reply(rows);
    if (url.pathname === "/api/chart-alerts") {
      if (rejectCreate) {
        rejectCreate = false;
        return reply({ detail: "fixture: 保存失败，请重试" }, 503);
      }
      const row = {
        id: "a".repeat(36),
        name: body.config.name,
        version: 1,
        run: 1,
        status: "active",
        health: "warming",
        health_reason: "等待行情",
        count: 0,
        max_triggers: body.config.max_triggers,
        effective_at: Date.now(),
        config: body.config,
        condition_summary: "价格 上穿 100",
      };
      rows.push(row);
      return reply(row, 201);
    }
    if (url.pathname.endsWith("/lifecycle")) {
      const row = rows[0];
      row.status = body.action === "pause" ? "paused" : "active";
      return reply(row);
    }
    if (url.pathname.endsWith("/ack")) {
      events[0].ack_at = Date.now();
      events[0].notification_status = "acknowledged";
      return reply({ ok: true });
    }
    return reply({ detail: "unexpected fixture route" }, 404);
  });
  try {
    await page.goto("https://chart-alert-ui.invalid/");
    await page.getByRole("button", { name: "创建告警", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel("触发次数").inputValue(), "1");
    assert.equal(
      await dialog.getByLabel("比较值", { exact: true }).inputValue(),
      "100",
    );
    await dialog.getByLabel("触发次数").selectOption("2");
    await dialog.getByRole("button", { name: /消息与通知/ }).click();
    await dialog.getByLabel("消息正文").fill("观察 {symbol}");
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    assert.equal(
      writes.filter((w) => w.path === "/api/chart-alerts").length,
      0,
    );
    report.cases.push(
      "message subpage applies only to draft; creation defaults to one trigger",
    );
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "fixture: 保存失败" })
      .waitFor();
    assert.equal(await dialog.getByLabel("触发次数").inputValue(), "2");
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    assert.equal(await dialog.getByLabel("触发次数").inputValue(), "2");
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const creations = writes.filter((w) => w.path === "/api/chart-alerts");
    assert.equal(creations.length, 2);
    assert.equal(creations[0].body.request_id, creations[1].body.request_id);
    assert.equal(creations[1].body.config.message, "观察 {symbol}");
    await page.getByText("等待数据 / 预热：等待行情").waitFor();
    report.cases.push(
      "failed save and cancellation preserve draft and idempotent request; warming displayed accurately",
    );
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "恢复", exact: true }).waitFor();
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await page.getByRole("button", { name: "暂停", exact: true }).waitFor();
    await page.getByRole("button", { name: "复制为草稿" }).click();
    assert.match(
      await dialog.getByLabel("名称", { exact: true }).inputValue(),
      /副本$/,
    );
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    assert.equal(rows.length, 1);
    events.push({
      id: "event-one",
      alert_id: rows[0].id,
      occurred_at: Date.now(),
      detected_at: Date.now(),
      price: "101",
      threshold: "100",
      notification_id: "notification-one",
      notification_status: "pending",
      delivery_status: "pending",
      ack_at: null,
      message: "fixture event",
      evidence: {
        config: rows[0].config,
        left: "101",
        rule_version: 1,
        ordinal: 1,
        late: false,
        observation: { sample: "fixture" },
      },
    });
    await page.getByRole("tab", { name: /日志/ }).click();
    await page
      .getByRole("button", { name: "确认此事件" })
      .waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "确认此事件" }).click();
    await page.getByRole("button", { name: "已确认", exact: true }).waitFor();
    report.cases.push(
      "pause/resume lifecycle; copy remains draft; event acknowledgement independent",
    );
    await page.getByRole("tab", { name: /告警 \(/ }).click();
    await page.screenshot({ path: output.replace(/\.json$/, ".dark.png") });
    await page.evaluate(() => setProbeTheme("light"));
    await page.screenshot({ path: output.replace(/\.json$/, ".light.png") });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(
        () => document.activeElement.closest("dialog") !== null,
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    report.cases.push(
      "dark/light render; modal keyboard focus and Escape cancellation",
    );
    assert.deepEqual(errors, []);
    report.errors = errors;
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
