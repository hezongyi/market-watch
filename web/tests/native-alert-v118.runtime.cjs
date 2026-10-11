// Deployed Ubuntu acceptance: native alerts coexist with current chart features.
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const APP = process.env.APP_ORIGIN || "https://localhost:19643";
const CHART = process.env.CHART_ORIGIN || "https://127.0.0.1:19644";
const PRIVATE = process.env.MW_ALERT_PRIVATE_DIR || "/tmp/mw-native-alert-ui-runtime";
const OUTPUT = process.env.MW_ALIGNMENT_OUTPUT || "/tmp/mw-native-alert-ui-v118-alignment";
const VERSION = process.env.MW_ALIGNMENT_VERSION || "1.18.0";

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const report = { scope: `Ubuntu Docker; actual v${VERSION} app, licensed chart and Binance SSE`, passed: false, cases: [], errors: [], credentials_sent_to_chart: [] };
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("request", request => {
    if (request.url().startsWith(CHART + "/") && (request.headers().cookie || request.headers().authorization))
      report.credentials_sent_to_chart.push(new URL(request.url()).pathname);
  });
  await page.addInitScript(() => {
    const Original = window.EventSource;
    window.__marketEvents = [];
    window.EventSource = class extends Original {
      constructor(url, options) {
        super(url, options);
        if (String(url).startsWith("/api/charts/stream/events"))
          this.addEventListener("message", event => {
            const value = JSON.parse(event.data);
            window.__marketEvents.push({ type: value.type, sequence: value.sequence, generation: value.generation });
          });
      }
    };
  });
  try {
    await page.goto(APP + "/");
    await page.getByLabel("管理员密码").fill(JSON.parse(fs.readFileSync(path.join(PRIVATE, "login.json"))).password);
    await page.getByRole("button", { name: "登录工作台" }).click();
    await expect(page.getByLabel("管理员密码")).toHaveCount(0);
    const api = (route, body) => page.evaluate(async ({ route, body }) => {
      const session = await (await fetch("/api/session")).json();
      const response = await fetch("/api" + route, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf }, body: JSON.stringify(body),
      });
      if (!response.ok) throw Error(route + " HTTP " + response.status);
      return response.json();
    }, { route, body });
    const workspace = await api("/advanced-charts/workspaces", { name: `v${VERSION} 原生告警兼容验收` });
    await api("/advanced-charts/workspaces/" + workspace.id + "/save", {
      name: workspace.name, revision: workspace.revision,
      document: { engine: "tv31", schemaVersion: 1, symbol: "MWP:BTCUSDT", interval: "1" },
    });
    report.workspace = workspace.id;
    await page.goto(APP + "/advanced-charts");
    await expect.poll(() => page.frames().some(frame => frame.url().startsWith(CHART + "/?")), { timeout: 30000 }).toBe(true);
    const host = page.frames().find(frame => frame.url().startsWith(CHART + "/?"));
    await host.waitForFunction(() => ready && !loading && alertUI && dataCenter && widget.activeChart().dataReady(), null, { timeout: 60000 });
    const native = host.childFrames()[0];
    const roots = () => host.locator('[data-name="mw-alert-state"]');
    await expect(roots()).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__marketEvents.filter(event => ["bars", "quotes"].includes(event.type)).length), { timeout: 45000 }).toBeGreaterThan(0);
    report.cases.push("Real Binance bars/quotes arrive through authenticated SSE with one alert business root");

    await host.evaluate(() => alertUI.open());
    await host.evaluate(() => alertBridge.create());
    const alert = native.locator('[data-name="mw-native-alert-dialog"]');
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "消息", exact: true }).click();
    const draft = "v1.18 兼容草稿 " + Date.now();
    await alert.getByLabel("警报名称", { exact: true }).fill(draft);
    await alert.getByRole("button", { name: "应用到草稿" }).click();
    await alert.getByRole("button", { name: "取消（保留草稿）" }).click();
    await expect(alert).toHaveCount(0);
    const identity = await host.evaluate(() => ({ symbol: widget.activeChart().symbol(), resolution: widget.activeChart().resolution() }));

    await native.getByRole("button", { name: "数据中心", exact: true }).click();
    const center = native.locator(".dc-window");
    await expect(center).toBeVisible();
    const sections = ["自建行情", "平台行情", "组合行情", "任务与记录", "来源状态"];
    if (VERSION !== "1.18.0") sections.push("交易日历");
    const navigation = center.locator(".dc-window-nav");
    await expect(navigation.getByRole("button")).toHaveCount(sections.length);
    for (const section of sections)
      await expect(navigation.getByRole("button", { name: section, exact: true })).toBeVisible();
    const statusRead = page.waitForResponse(response => response.url().endsWith("/api/market-data/live/status") && response.request().method() === "GET");
    await center.getByRole("button", { name: "来源状态", exact: true }).click();
    assert.equal((await statusRead).status(), 200);
    await expect(center.getByRole("heading", { name: "来源状态", exact: true })).toBeVisible();
    await expect(center).not.toContainText("正在读取状态…", { timeout: 15000 });
    await expect(roots()).toHaveCount(1);
    await page.screenshot({ path: path.join(OUTPUT, "v118-source-status.png") });
    await native.getByRole("button", { name: "关闭数据中心", exact: true }).click();
    await expect(center).toHaveCount(0);
    assert.deepEqual(await host.evaluate(() => ({ symbol: widget.activeChart().symbol(), resolution: widget.activeChart().resolution() })), identity);
    report.cases.push("Data center retains versioned sections and actual source-status reads; close preserves chart identity and alert root");

    await native.getByRole("button", { name: "指标", exact: true }).click();
    const indicators = native.locator('[data-name="indicators-dialog"]');
    await expect(indicators).toBeVisible();
    await expect(indicators.locator(".mw-native-indicator-content")).toBeVisible();
    await indicators.getByLabel("搜索指标", { exact: true }).fill("SMA");
    await expect(indicators.locator('[data-study-name="守望 Python SMA"]')).toBeVisible();
    await page.screenshot({ path: path.join(OUTPUT, "v118-indicators.png") });
    await indicators.getByRole("button", { name: "关闭指标窗口", exact: true }).click();
    await expect(indicators).toHaveCount(0);
    await expect(roots()).toHaveCount(1);
    report.cases.push("Native indicator controller and search coexist with the native alert adapter");

    await native.getByRole("button", { name: "更多选项", exact: true }).click();
    await native.getByRole("menuitem", { name: "恢复草稿", exact: true }).click();
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "消息", exact: true }).click();
    await expect(alert.getByLabel("警报名称", { exact: true })).toHaveValue(draft);
    await alert.getByRole("button", { name: "应用到草稿" }).click();
    await alert.getByRole("button", { name: "取消（保留草稿）" }).click();
    await host.evaluate(() => widget.changeTheme("Light"));
    await expect(native.locator(".chart-alert-panel")).toHaveAttribute("data-theme", "light");
    await page.screenshot({ path: path.join(OUTPUT, "v118-alerts-light.png") });
    await host.evaluate(() => widget.changeTheme("Dark"));
    await expect(native.locator(".chart-alert-panel")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: path.join(OUTPUT, "v118-alerts-dark.png") });
    await expect(roots()).toHaveCount(1);
    report.cases.push("Alert draft survives data center/indicator use; both themes retain one renderer");
    report.market_events = await page.evaluate(() => window.__marketEvents);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.credentials_sent_to_chart, []);
    report.passed = true;
  } catch (error) {
    report.failure = String(error);
    await page.screenshot({ path: path.join(OUTPUT, "v118-coexistence-failure.png") }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(OUTPUT, "runtime-v118.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
