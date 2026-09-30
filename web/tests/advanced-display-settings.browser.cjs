// Public price scale / timezone operations and native save / reload.
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
  const initial = await frame.evaluate(() => ({
    symbol: widget.activeChart().symbol(),
    resolution: widget.activeChart().resolution(),
  }));
  for (const mode of [1, 2, 3, 0]) {
    await frame.evaluate(
      (mode) =>
        widget
          .activeChart()
          .getPanes()[0]
          .getMainSourcePriceScale()
          .setMode(mode),
      mode,
    );
    assert.equal(
      await frame.evaluate(() =>
        widget.activeChart().getPanes()[0].getMainSourcePriceScale().getMode(),
      ),
      mode,
    );
  }
  await frame.evaluate(() => {
    const c = widget.activeChart();
    c.getTimezoneApi().setTimezone("Asia/Singapore");
    c.getPanes()[0].getMainSourcePriceScale().setMode(1);
    c.getPanes()[0].getMainSourcePriceScale().setInverted(true);
  });
  await page.waitForTimeout(2500);
  await frame.waitForFunction(() => !nativeSaving && !rangeGuard?.busy());
  await frame.evaluate(
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
  const actual = await restored.evaluate(() => {
    const c = widget.activeChart(),
      scale = c.getPanes()[0].getMainSourcePriceScale();
    return {
      mode: scale.getMode(),
      inverted: scale.isInverted(),
      timezone: c.getTimezoneApi().getTimezone().id,
      symbol: c.symbol(),
      resolution: c.resolution(),
    };
  });
  assert.deepEqual(actual, {
    ...initial,
    mode: 1,
    inverted: true,
    timezone: "Asia/Singapore",
  });
  assert.deepEqual(errors, []);
  console.log("DISPLAY_SETTINGS_RELOAD_PASSED", actual);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
