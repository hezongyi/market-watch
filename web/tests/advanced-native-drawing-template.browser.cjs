// Native drawing template save and cross-workspace application; actual drawings stay local.
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
  await frame.evaluate(async () => {
    const c = widget.activeChart();
    const id = await c.createShape(
      { time: 1790323200, price: 4300 },
      { shape: "horizontal_line" },
    );
    c.getShapeById(id).setProperties({ linecolor: "#ff1234", linewidth: 3 });
    c.showPropertiesDialog(id);
  });
  await ui.getByText("模板", { exact: true }).click();
  await ui.getByText(/保存为/).click();
  const name = "绘图模板验收-" + Date.now();
  await ui.locator("input[maxlength]").fill(name);
  await ui.locator("input[maxlength]").press("Enter");
  await page.waitForFunction(
    async (name) =>
      (await (await fetch("/api/advanced-charts/preferences")).json()).some(
        (r) => r.kind === "drawing" && r.name === name,
      ),
    name,
  );
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const r = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "绘图模板另一工作区" }),
    });
    if (!r.ok) throw Error("create " + r.status);
  });
  await page.reload();
  await page.waitForTimeout(15000);
  const second = page
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  await second.waitForFunction(
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
  assert.equal(
    await second.evaluate(() => widget.activeChart().getAllShapes().length),
    0,
  );
  const id = await second.evaluate(async () => {
    const c = widget.activeChart();
    const id = await c.createShape(
      { time: 1790323200, price: 4200 },
      { shape: "horizontal_line" },
    );
    c.getShapeById(id).setProperties({ linecolor: "#1234ff", linewidth: 1 });
    c.showPropertiesDialog(id);
    return id;
  });
  const secondUI = second.childFrames()[0];
  await secondUI.getByText("模板", { exact: true }).click();
  await secondUI.getByText(name, { exact: true }).click();
  await secondUI.getByRole("button", { name: "确认", exact: true }).click();
  const shape = await second.evaluate((id) => {
    const s = widget.activeChart().getShapeById(id);
    return { properties: s.getProperties(), points: s.getPoints() };
  }, id);
  assert.equal(shape.properties.linecolor, "#ff1234");
  assert.equal(shape.properties.linewidth, 3);
  assert.equal(shape.points[0].price, 4200);
  assert.equal(
    await second.evaluate(() => widget.activeChart().getAllShapes().length),
    1,
  );
  await page.waitForTimeout(2500);
  await second.waitForFunction(() => !nativeSaving && !rangeGuard?.busy());
  await second.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
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
  const persisted = await restored.evaluate(() => {
    const c = widget.activeChart();
    return c.getAllShapes().map((x) => ({
      properties: c.getShapeById(x.id).getProperties(),
      points: c.getShapeById(x.id).getPoints(),
    }));
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].properties.linecolor, "#ff1234");
  assert.equal(persisted[0].properties.linewidth, 3);
  assert.equal(persisted[0].points[0].price, 4200);
  await restored.evaluate(() => {
    const c = widget.activeChart();
    c.showPropertiesDialog(c.getAllShapes()[0].id);
  });
  const restoredUI = restored.childFrames()[0];
  await restoredUI.getByText("模板", { exact: true }).click();
  await restoredUI.getByText(name, { exact: true }).hover();
  const menuItem = restoredUI
    .getByText(name, { exact: true })
    .locator("..")
    .locator("..");
  await menuItem.locator('[data-name="remove-button"]').click();
  await page.waitForFunction(
    async (name) =>
      !(await (await fetch("/api/advanced-charts/preferences")).json()).some(
        (r) => r.kind === "drawing" && r.name === name,
      ),
    name,
  );
  const retained = await restored.evaluate(() => {
    const c = widget.activeChart();
    return c.getAllShapes().map((s) => ({
      props: c.getShapeById(s.id).getProperties(),
      points: c.getShapeById(s.id).getPoints(),
    }));
  });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].props.linecolor, "#ff1234");
  assert.equal(retained[0].props.linewidth, 3);
  assert.equal(retained[0].points[0].price, 4200);
  assert.deepEqual(errors, []);
  console.log("DRAWING_TEMPLATE_CROSS_WORKSPACE_PASSED", {
    color: shape.properties.linecolor,
    width: shape.properties.linewidth,
    price: shape.points[0].price,
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
