// Native study template UI → real development API → different workspace → reload.
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
  const blank = await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "空白切换验收" }),
    });
    if (!response.ok) throw Error("create " + response.status);
    return response.json();
  });
  await frame.evaluate(async () => {
    const c = widget.activeChart();
    await c.createShape(
      { time: 1790323200, price: 4300 },
      { shape: "horizontal_line" },
    );
    await c.createStudy("Moving Average", false, false, { length: 21 });
  });
  await page.waitForTimeout(2500);
  await frame.waitForFunction(() => !nativeSaving && !rangeGuard?.busy());
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  await frame.evaluate(async (id) => {
    const rows = await new Promise((ok) => widget.getSavedCharts(ok));
    void widget.loadChartFromServer(rows.find((r) => String(r.id) === id));
  }, blank.id);
  await page.waitForFunction(
    (id) =>
      document.querySelector("iframe[data-workspace-id]")?.dataset
        .workspaceId === id,
    blank.id,
  );
  await page.waitForTimeout(15000);
  const fresh = page
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  await fresh.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 30000 },
  );
  assert.equal(
    await fresh.evaluate(() => widget.activeChart().getAllShapes().length),
    0,
  );
  assert.equal(
    await fresh.evaluate(() => widget.activeChart().getAllStudies().length),
    0,
  );
  assert.deepEqual(errors, []);
  console.log("EMPTY_NATIVE_WORKSPACE_LOAD_PASSED");
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
