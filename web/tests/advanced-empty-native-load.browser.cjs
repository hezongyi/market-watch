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
  await fresh.evaluate(async (id) => {
    const rows = await new Promise((ok) => widget.getSavedCharts(ok));
    await widget.loadChartFromServer(rows.find((r) => String(r.id) === id));
  }, originalWorkspace);
  await fresh.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 30000 },
  );
  const restoredAnalysis = await fresh.evaluate(() => {
    const c = widget.activeChart(),
      shapes = c.getAllShapes(),
      studies = c.getAllStudies();
    return {
      shapes: shapes.length,
      price: c.getShapeById(shapes[0].id).getPoints()[0].price,
      studies: studies.length,
      inputs: c.getStudyById(studies[0].id).getInputValues(),
    };
  });
  assert.equal(restoredAnalysis.shapes, 1);
  assert.equal(restoredAnalysis.price, 4300);
  assert.equal(restoredAnalysis.studies, 1);
  assert.ok(
    restoredAnalysis.inputs.some(
      (input) => input.id === "length" && input.value === 21,
    ),
  );
  assert.equal(
    await page
      .locator("iframe[data-workspace-id]")
      .getAttribute("data-workspace-id"),
    originalWorkspace,
  );
  const mobileBlank = await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const r = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "手机空白切换验收" }),
    });
    if (!r.ok) throw Error("create " + r.status);
    return r.json();
  });
  const mobile = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    storageState: await page.context().storageState(),
  });
  await page.close();
  await mobile.goto("https://localhost:15443/");
  const serverBefore = await mobile.evaluate(async () =>
    (await fetch("/api/advanced-charts/workspaces")).json(),
  );
  const writes = [];
  mobile.on("pageerror", (e) => errors.push(e.message));
  mobile.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/advanced-charts/"))
      writes.push(new URL(r.url()).pathname);
  });
  await mobile.route(/\/api\/(market-data\/history|charts\/data)$/, (route) => {
    const q = route.request().postDataJSON();
    return route.continue({
      postData: JSON.stringify({
        ...q,
        before: Math.min(q.before || 1790622000000, 1790622000000),
      }),
    });
  });
  await mobile.goto("https://localhost:15443/advanced-charts");
  await mobile.waitForTimeout(15000);
  let mf = mobile
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  await mf.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 30000 },
  );
  await mf.evaluate(async (id) => {
    const rows = await new Promise((ok) => widget.getSavedCharts(ok));
    await widget.loadChartFromServer(rows.find((r) => String(r.id) === id));
  }, originalWorkspace);
  await mf.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 30000 },
  );
  assert.equal(
    await mf.evaluate(() => widget.activeChart().getAllShapes().length),
    1,
  );
  await mf.evaluate(async (id) => {
    const rows = await new Promise((ok) => widget.getSavedCharts(ok));
    void widget.loadChartFromServer(rows.find((r) => String(r.id) === id));
  }, mobileBlank.id);
  await mobile.waitForFunction(
    (id) =>
      document.querySelector("iframe[data-workspace-id]")?.dataset
        .workspaceId === id,
    mobileBlank.id,
  );
  await mobile.waitForTimeout(15000);
  mf = mobile
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  await mf.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 30000 },
  );
  assert.deepEqual(
    await mf.evaluate(() => ({
      count: widget.chartsCount(),
      shapes: widget.activeChart().getAllShapes().length,
      studies: widget.activeChart().getAllStudies().length,
    })),
    { count: 1, shapes: 0, studies: 0 },
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(
    await mobile.evaluate(async () =>
      (await fetch("/api/advanced-charts/workspaces")).json(),
    ),
    serverBefore,
  );
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log("EMPTY_NATIVE_WORKSPACE_LOAD_PASSED");
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
