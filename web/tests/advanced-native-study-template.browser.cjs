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
  await frame.evaluate(() =>
    widget
      .activeChart()
      .createStudy("Moving Average", false, false, { length: 21 }),
  );
  await ui.getByRole("button", { name: "指标模板", exact: true }).click();

  await ui.getByText("保存指标模板", { exact: false }).click();
  const templateName = "验收MA覆盖-" + Date.now();
  await ui.locator('input[maxlength="64"]').fill(templateName);
  await ui.locator('input[maxlength="64"]').press("Enter");
  await page.waitForFunction(
    async (name) =>
      (await (await fetch("/api/advanced-charts/preferences")).json()).some(
        (r) => r.kind === "study" && r.name === name,
      ),
    templateName,
  );
  const stored = await page.evaluate(
    async (name) =>
      (await (await fetch("/api/advanced-charts/preferences")).json()).find(
        (r) => r.kind === "study" && r.name === name,
      ),
    templateName,
  );
  assert.equal(typeof stored.content.value, "string");
  await frame.evaluate(() => {
    const chart = widget.activeChart();
    chart
      .getStudyById(chart.getAllStudies()[0].id)
      .setInputValues([{ id: "length", value: 34 }]);
  });
  await ui.getByRole("button", { name: "指标模板", exact: true }).click();
  await ui.getByText("保存指标模板", { exact: false }).click();
  await ui.locator('input[maxlength="64"]').fill(templateName);
  await ui.getByRole("button", { name: "保存", exact: true }).last().click();
  let overwritten = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const confirmation = ui.getByRole("button", { name: "是", exact: true });
    if (await confirmation.isVisible()) await confirmation.click();
    overwritten = await page.evaluate(
      async (name) =>
        (await (await fetch("/api/advanced-charts/preferences")).json()).filter(
          (r) => r.kind === "study" && r.name === name,
        ),
      templateName,
    );
    if (overwritten[0]?.revision > stored.revision) break;
    await page.waitForTimeout(500);
  }
  assert.equal(
    overwritten.length,
    1,
    "Overwrite must not duplicate the template",
  );
  assert.equal(overwritten[0].id, stored.id);
  assert.equal(overwritten[0].revision, stored.revision + 1);
  assert.notEqual(overwritten[0].content.value, stored.content.value);

  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const r = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "模板跨工作区验收" }),
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
  const secondUI = second.childFrames()[0];
  assert.equal(
    (await second.evaluate(() => widget.activeChart().getAllStudies())).length,
    0,
  );
  await secondUI.getByRole("button", { name: "指标模板", exact: true }).click();
  await secondUI.getByText(templateName, { exact: true }).click();
  await second.waitForFunction(
    () => widget.activeChart().getAllStudies().length === 1,
  );
  const applied = await second.evaluate(() => {
    const c = widget.activeChart();
    return c.getStudyById(c.getAllStudies()[0].id).getInputValues();
  });
  assert.ok(
    applied.some((x) => x.id === "length" && x.value === 34),
    JSON.stringify(applied),
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
  const restoredInputs = await restored.evaluate(() => {
    const c = widget.activeChart();
    return c.getStudyById(c.getAllStudies()[0].id).getInputValues();
  });
  assert.deepEqual(restoredInputs, applied);
  const restoredUI = restored.childFrames()[0];
  await restoredUI
    .getByRole("button", { name: "指标模板", exact: true })
    .click();
  const label = restoredUI.getByText(templateName, { exact: true });
  await label.hover();
  await label
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "移除", exact: true })
    .click();
  await page.waitForFunction(
    async (name) =>
      !(await (await fetch("/api/advanced-charts/preferences")).json()).some(
        (r) => r.kind === "study" && r.name === name,
      ),
    templateName,
  );
  const retained = await restored.evaluate(() => {
    const c = widget.activeChart();
    return c.getAllStudies().map((s) => c.getStudyById(s.id).getInputValues());
  });
  assert.equal(retained.length, 1);
  assert.deepEqual(retained[0], applied);
  assert.deepEqual(errors, []);
  console.log("NATIVE_STUDY_TEMPLATE_CROSS_WORKSPACE_PASSED", {
    inputs: applied,
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
