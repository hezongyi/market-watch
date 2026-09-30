// Native copy/paste independence and user-edited drawing defaults across workspaces.
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
  const sourceId = await frame.evaluate(async () => {
    const c = widget.activeChart();
    const id = await c.createShape(
      { time: 1790323200, price: 4300 },
      { shape: "horizontal_line" },
    );
    c.getShapeById(id).setProperties({ linecolor: "#12ab34", linewidth: 4 });
    c.selection().add([id]);
    return id;
  });
  const chartBox = await ui.locator(".chart-container").first().boundingBox();
  await page.mouse.click(
    chartBox.x + chartBox.width / 2,
    chartBox.y + chartBox.height / 2,
  );
  await frame.evaluate(
    (id) => widget.activeChart().selection().add([id]),
    sourceId,
  );
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await frame.waitForFunction(
    () => widget.activeChart().getAllShapes().length === 2,
    null,
    { timeout: 10000 },
  );
  const copied = await frame.evaluate((id) => {
    const c = widget.activeChart();
    return c
      .getAllShapes()
      .filter((s) => s.id !== id)
      .map((s) => ({
        id: s.id,
        props: c.getShapeById(s.id).getProperties(),
        points: c.getShapeById(s.id).getPoints(),
      }));
  }, sourceId);
  assert.equal(copied[0].props.linecolor, "#12ab34");
  assert.equal(copied[0].props.linewidth, 4);
  await frame.evaluate(
    (id) =>
      widget
        .activeChart()
        .getShapeById(id)
        .setPoints([{ time: 1790323200, price: 4250 }]),
    copied[0].id,
  );
  assert.equal(
    await frame.evaluate(
      (id) => widget.activeChart().getShapeById(id).getPoints()[0].price,
      sourceId,
    ),
    4300,
  );
  await frame.evaluate(
    (id) => widget.activeChart().showPropertiesDialog(id),
    sourceId,
  );
  await ui.getByText("样式", { exact: true }).click();
  const priceLabel = ui.locator('input[type="checkbox"]').first();
  const defaultShowPrice = !(await priceLabel.isChecked());
  await priceLabel.setChecked(defaultShowPrice);
  await ui.getByRole("button", { name: "确认", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const r = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "绘图默认样式跨工作区" }),
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
  const defaults = await second.evaluate(async () => {
    const c = widget.activeChart();
    if (c.getAllShapes().length) throw Error("Workspace drawings leaked");
    const id = await c.createShape(
      { time: 1790323200, price: 4200 },
      { shape: "horizontal_line" },
    );
    return c.getShapeById(id).getProperties();
  });
  assert.equal(defaults.showPrice, defaultShowPrice);
  console.log("DRAWING_DEFAULT_STYLE_SHARED", {
    color: defaults.linecolor,
    width: defaults.linewidth,
  });
  assert.deepEqual(errors, []);
  console.log("DRAWING_COPY_PASTE_PASSED", {
    sourceId,
    copyId: copied[0].id,
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
