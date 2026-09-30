// Independent style save → real API → different workspace → native template menu.
// Requires the local acceptance Compose stack; self-signed TLS is test-only.
const { chromium } = require("playwright");
const fs = require("node:fs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/\/api\/(market-data\/history|charts\/data)$/, (route) => {
    const body = route.request().postDataJSON();
    return route.continue({
      postData: JSON.stringify({
        ...body,
        before: Math.min(body.before || 1790622000000, 1790622000000),
      }),
    });
  });
  await page.goto("https://localhost:15443/");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync("../../market-watch/artifacts/local-credentials.json"),
      ).password,
    );
  const login = page.waitForResponse(
    (r) => r.url().endsWith("/api/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录工作台" }).click();
  assert.equal((await login).status(), 200);
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "容器HTTPS验收" }),
    });
    if (!response.ok)
      throw Error("Workspace creation failed " + response.status);
  });
  await page.goto("https://localhost:15443/advanced-charts");
  await page
    .locator('iframe[title="专业图表工作区"]')
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(15000);
  const frame = page
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  assert.ok(frame, "isolated HTTPS chart frame must load");
  await frame.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  const originalWorkspace = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  const ui = frame.childFrames()[0];
  assert.ok(ui);
  const name = "样式替代验收-" + Date.now();
  await frame.evaluate(() =>
    widget.applyOverrides({
      "paneProperties.background": "#123456",
      "paneProperties.backgroundType": "solid",
    }),
  );
  page.once("dialog", (dialog) => dialog.accept(name));
  await ui
    .getByRole("button", { name: "保存图表样式模板", exact: true })
    .click();
  await page.waitForFunction(
    async (name) =>
      (await (await fetch("/api/advanced-charts/preferences")).json()).some(
        (r) => r.kind === "chart" && r.name === name,
      ),
    name,
  );
  const stored = await page.evaluate(
    async (name) =>
      (await (await fetch("/api/advanced-charts/preferences")).json()).find(
        (r) => r.kind === "chart" && r.name === name,
      ),
    name,
  );
  assert.equal(
    stored.content.value.chartProperties.paneProperties.background,
    "#123456",
  );
  assert.equal(stored.content.value.mainSourceProperties.symbol, undefined);
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "样式跨工作区验收" }),
    });
    if (!response.ok) throw Error("create " + response.status);
  });
  await page.reload();
  await page.waitForTimeout(15000);
  const restored = page
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  await restored.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  assert.notEqual(
    await page
      .locator("iframe[data-workspace-id]")
      .getAttribute("data-workspace-id"),
    originalWorkspace,
  );
  const before = await restored.evaluate(async () => {
    widget.applyOverrides({ "paneProperties.background": "#654321" });
    const c = widget.activeChart();
    await c.createStudy("Moving Average", false, false, { length: 21 });
    await c.createShape(
      { time: 1790323200, price: 4300 },
      { shape: "horizontal_line" },
    );
    return {
      symbol: c.symbol(),
      resolution: c.resolution(),
      studies: c.getAllStudies(),
      shapes: c.getAllShapes(),
    };
  });
  const restoredUI = restored.childFrames()[0];
  await restoredUI.locator("#header-toolbar-properties").click();
  await restoredUI.getByText("模板", { exact: true }).click();
  await restoredUI.getByText(name, { exact: true }).click();
  await restoredUI.getByRole("button", { name: "确认", exact: true }).click();
  const after = await restored.evaluate(async () => {
    const c = widget.activeChart();
    const state = await new Promise((ok) => widget.save(ok));
    return {
      symbol: c.symbol(),
      resolution: c.resolution(),
      studies: c.getAllStudies(),
      shapes: c.getAllShapes(),
      background: state.charts[0].chartProperties.paneProperties.background,
    };
  });
  assert.equal(after.background, "#123456");
  delete after.background;
  assert.deepEqual(after, before);
  await restoredUI.locator("#header-toolbar-properties").click();
  await restoredUI.getByText("模板", { exact: true }).click();
  const item = restoredUI
    .locator("[data-series-theme-item-theme-name]")
    .filter({ hasText: name });
  await item.hover();
  await item.getByRole("button", { name: "移除", exact: true }).click();
  await restoredUI.getByRole("button", { name: "是", exact: true }).click();
  await page.waitForFunction(
    async (name) =>
      !(await (await fetch("/api/advanced-charts/preferences")).json()).some(
        (r) => r.kind === "chart" && r.name === name,
      ),
    name,
  );
  assert.deepEqual(errors, []);
  console.log("STYLE_CROSS_WORKSPACE_NATIVE_APPLY_DELETE_PASSED", {
    preserved: after,
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
