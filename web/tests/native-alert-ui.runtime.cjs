// Actual Ubuntu Docker UI/API. Uses only this task's private configuration and
// fixture IDs; no route mocks, licensed bundles or browser credentials exported.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const PRIVATE = "/tmp/mw-native-alert-ui-runtime";
const APP = "https://localhost:19643";
const CHART = "https://127.0.0.1:19644";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
  });
  const errors = [],
    leaked = [];
  const report = {
    scope:
      "Ubuntu Docker; shipped parent/native UI and real HTTPS API, persisted worker fixture events",
    passed: false,
    cases: [],
  };
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => {
    if (
      request.url().startsWith(CHART + "/") &&
      (request.headers().cookie || request.headers().authorization)
    )
      leaked.push(new URL(request.url()).pathname);
  });
  const prior = JSON.parse(fs.readFileSync(PRIVATE + "/runtime-browser.json"));
  const fixture = JSON.parse(
    fs.readFileSync(PRIVATE + "/fault-acceptance.json"),
  );
  try {
    await page.goto(APP + "/");
    await page
      .getByLabel("管理员密码")
      .fill(JSON.parse(fs.readFileSync(PRIVATE + "/login.json")).password);
    const login = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/login") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "登录工作台" }).click();
    assert.equal((await login).status(), 200);
    await page.goto(APP + "/advanced-charts");
    await page.locator('iframe[title="专业图表工作区"]').waitFor();
    const iframe = await page
      .locator('iframe[title="专业图表工作区"]')
      .elementHandle();
    const host = await iframe.contentFrame();
    await host.waitForURL(CHART + "/**");
    await host.waitForFunction(
      () => ready && !loading && alertUI && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    const chart = host.childFrames()[0];
    const dialog = chart.locator('[data-name="mw-native-alert-dialog"]');
    await host.evaluate(() => alertUI.open());
    const api = async (path, body) =>
      page.evaluate(
        async ({ path, body }) => {
          const session = await (await fetch("/api/session")).json();
          const response = await fetch(
            "/api" + path,
            body === undefined
              ? {}
              : {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": session.csrf,
                  },
                  body: JSON.stringify(body),
                },
          );
          if (!response.ok) throw Error(path + " HTTP " + response.status);
          return response.json();
        },
        { path, body },
      );

    const price = await api("/chart-alerts/" + prior.price_alert);
    const row = chart
      .locator(".chart-alert-card")
      .filter({ has: chart.getByText(price.name, { exact: true }) });
    await row.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    const renamed = "原生窗口实际验收 " + Date.now();
    await dialog.getByLabel("警报名称", { exact: true }).fill(renamed);
    await dialog.getByLabel("消息正文").fill("实际窗口保存 {symbol}");
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    await dialog.getByRole("button", { name: "通知", exact: true }).click();
    const web = dialog.getByLabel("网页声音与提醒");
    await web.click();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.getByRole("button", { name: "通知", exact: true }).click();
    assert.equal(await web.isChecked(), price.config.notify_web);
    await dialog.getByRole("button", { name: "返回", exact: true }).click();
    await dialog
      .getByRole("button", { name: "保存新版本", exact: true })
      .click();
    await dialog.waitFor({ state: "detached" });
    const saved = await api("/chart-alerts/" + price.id);
    assert.equal(saved.version, price.version + 1);
    assert.equal(saved.config.message, "实际窗口保存 {symbol}");
    assert.equal(saved.config.notify_web, price.config.notify_web);
    report.cases.push(
      "Real native message/notification pages apply and cancel draft; edit persists one new version through parent API",
    );

    await chart.getByRole("button", { name: "搜索告警" }).click();
    await chart.getByLabel("搜索", { exact: true }).fill(renamed);
    const edited = chart
      .locator(".chart-alert-card")
      .filter({ has: chart.getByText(renamed, { exact: true }) });
    await edited.waitFor();
    await page.screenshot({ path: PRIVATE + "/runtime-native-sidebar.png" });
    await edited.getByRole("button", { name: /行操作/ }).click();
    await chart
      .getByRole("menuitem", { name: "复制为草稿", exact: true })
      .click();
    await dialog.waitFor();
    const beforeCopy = (await api("/chart-alerts")).length;
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const all = await api("/chart-alerts");
    assert.equal(all.length, beforeCopy + 1);
    const copy = all.find(
      (item) => item.name === renamed + " 副本" && item.id !== price.id,
    );
    assert.ok(copy);
    const copied = chart
      .locator(".chart-alert-card")
      .filter({ has: chart.getByText(copy.name, { exact: true }) });
    await copied
      .last()
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await dialog.waitFor();
    await page.screenshot({ path: PRIVATE + "/runtime-native-edit.png" });
    await dialog.getByRole("button", { name: "删除告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const states = await Promise.all([
      api("/chart-alerts/" + copy.id),
      api("/chart-alerts/" + price.id),
    ]);
    assert.equal(states.filter((item) => item.status === "archived").length, 1);
    assert.equal(states[0].status, "archived");
    report.cases.push(
      "Native row copy creates only after final save; edit footer archives one persisted rule",
    );

    await chart.getByRole("button", { name: "关闭搜索" }).click();
    await chart.getByRole("tab", { name: "日志", exact: true }).click();
    const events = await api(
      "/chart-alerts/events?alert_id=" + fixture.close_alert,
    );
    const pending = events.find((event) => !event.ack_at);
    assert.ok(pending);
    const eventRows = chart
      .locator(".alert-event-day .chart-alert-card")
      .filter({ hasText: pending.evidence.config.name });
    await eventRows.first().waitFor();
    let acknowledged = false;
    for (let index = 0; index < (await eventRows.count()); index++) {
      const candidate = eventRows.nth(index);
      await candidate.locator(".alert-row-summary").click();
      const ack = candidate.getByRole("button", {
        name: "确认此事件",
        exact: true,
      });
      if (await ack.count()) {
        await ack.click();
        await candidate
          .getByRole("button", { name: "已确认", exact: true })
          .waitFor();
        acknowledged = true;
        break;
      }
    }
    assert.equal(acknowledged, true);
    const afterAck = await api(
      "/chart-alerts/events?alert_id=" + fixture.close_alert,
    );
    assert.equal(
      afterAck.filter((event) => event.ack_at).length,
      events.filter((event) => event.ack_at).length + 1,
    );
    assert.equal((await api("/chart-alerts/" + fixture.close_alert)).count, 3);
    await page.screenshot({ path: PRIVATE + "/runtime-native-log.png" });
    report.cases.push(
      "Native date-grouped log displays real worker evidence; one UI acknowledgement leaves rule count and other events intact",
    );

    await chart.getByRole("tab", { name: "警报", exact: true }).click();
    await chart.getByRole("button", { name: "全屏模式", exact: true }).click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.equal(await host.locator('[data-name="mw-alert-state"]').count(), 1);
    await host.evaluate(() => alertBridge.create());
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await page.evaluate(() => document.exitFullscreen());
    await chart
      .locator('[data-name="mw-native-alert-content"]')
      .waitFor({ state: "visible" });
    report.cases.push(
      "Actual parent iframe fullscreen permits native alert dialog; exit restores sidebar with one business root",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(leaked, []);
    report.passed = true;
  } catch (error) {
    report.failure = String(error);
    await page.screenshot({ path: PRIVATE + "/runtime-native-failure.png" });
    throw error;
  } finally {
    report.errors = errors;
    report.credentials_sent_to_chart = leaked;
    fs.writeFileSync(
      PRIVATE + "/runtime-native-ui.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
