// Native visibility control and public layer operations persist in workspace state.
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
  const ids = await frame.evaluate(async () => {
    const c = widget.activeChart(),
      ids = [];
    for (const price of [4300, 4310])
      ids.push(
        await c.createShape(
          { time: 1790323200, price },
          { shape: "horizontal_line" },
        ),
      );
    c.showPropertiesDialog(ids[0]);
    return ids;
  });
  await ui.getByText("可见范围", { exact: true }).click();
  const checkboxes = ui.locator(
    'input[type="checkbox"][name="toggle-enabled"]',
  );
  assert.equal(await checkboxes.count(), 5);
  await checkboxes.nth(1).uncheck(); // native hours row
  await ui.getByRole("button", { name: "确认", exact: true }).click();
  const visibility = (await sources(frame)).find((s) => s.id === ids[0]).state
    .intervalsVisibilities;
  assert.equal(visibility.hours, false);
  assert.equal(visibility.minutes, true);
  assert.equal(visibility.days, true);
  async function sources(target) {
    return target.evaluate(
      () =>
        new Promise((ok) =>
          widget.save((s) =>
            ok(
              s.charts[0].panes
                .flatMap((p) => p.sources)
                .filter((s) => s.type.startsWith("LineTool")),
            ),
          ),
        ),
    );
  }
  await frame.evaluate(
    (id) => widget.activeChart().getShapeById(id).bringToFront(),
    ids[0],
  );
  const front = await sources(frame);
  assert.ok(
    front.find((s) => s.id === ids[0]).zorder >
      front.find((s) => s.id === ids[1]).zorder,
  );
  await frame.evaluate(
    (id) => widget.activeChart().getShapeById(id).sendToBack(),
    ids[0],
  );
  const back = await sources(frame);
  assert.ok(
    back.find((s) => s.id === ids[0]).zorder <
      back.find((s) => s.id === ids[1]).zorder,
  );
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
  const reloaded = await sources(restored);
  assert.equal(reloaded.length, 2);
  assert.ok(
    reloaded.find((s) => s.id === ids[0]).zorder <
      reloaded.find((s) => s.id === ids[1]).zorder,
  );
  assert.deepEqual(
    reloaded.find((s) => s.id === ids[0]).state.intervalsVisibilities,
    visibility,
  );
  await restored.evaluate(
    (id) => widget.activeChart().showPropertiesDialog(id),
    ids[0],
  );
  const ru = restored.childFrames()[0];
  await ru.getByText("可见范围", { exact: true }).click();
  const restoredCheckboxes = ru.locator(
    'input[type="checkbox"][name="toggle-enabled"]',
  );
  assert.equal(await restoredCheckboxes.nth(1).isChecked(), false);
  assert.equal(await restoredCheckboxes.nth(0).isChecked(), true);
  assert.equal(await restoredCheckboxes.nth(2).isChecked(), true);
  await ru.getByRole("button", { name: "确认", exact: true }).click();
  await restored.evaluate((id) => {
    const c = widget.activeChart();
    c.getShapeById(id).setProperties({ linecolor: "#ff00ff", linewidth: 4 });
    const scale = c.getPanes()[0].getMainSourcePriceScale();
    scale.setMode(0);
    scale.setAutoScale(false);
    scale.setVisiblePriceRange({ from: 4200, to: 4400 });
  }, ids[0]);
  async function magentaPixels() {
    await page.waitForTimeout(400);
    return ru.locator(".chart-container canvas").evaluateAll((canvases) => {
      let count = 0;
      for (const canvas of canvases) {
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] > 220 &&
            pixels[i + 1] < 40 &&
            pixels[i + 2] > 220 &&
            pixels[i + 3] > 200
          )
            count++;
      }
      return count;
    });
  }
  const hiddenPixels = await magentaPixels();
  await restored.evaluate(
    (id) => widget.activeChart().showPropertiesDialog(id),
    ids[0],
  );
  await ru.getByText("可见范围", { exact: true }).click();
  await restoredCheckboxes.nth(1).check();
  await ru.getByRole("button", { name: "确认", exact: true }).click();
  const shownPixels = await magentaPixels();
  assert.ok(
    shownPixels > hiddenPixels + 500,
    `Enabling hours must render horizontal line: hidden=${hiddenPixels}, shown=${shownPixels}`,
  );
  await restored.evaluate(
    (id) => widget.activeChart().showPropertiesDialog(id),
    ids[0],
  );
  await ru.getByText("可见范围", { exact: true }).click();
  await restoredCheckboxes.nth(1).uncheck();
  await ru.getByRole("button", { name: "确认", exact: true }).click();
  const hiddenAgainPixels = await magentaPixels();
  assert.ok(
    hiddenAgainPixels < shownPixels - 500,
    "Disabling hours must remove rendered line",
  );
  console.log("H4_VISIBILITY_PIXELS", {
    hiddenPixels,
    shownPixels,
    hiddenAgainPixels,
  });
  await restored.evaluate(
    () => new Promise((ok) => widget.activeChart().setResolution("15", ok)),
  );
  await restored.waitForFunction(
    () =>
      widget.activeChart().resolution() === "15" &&
      widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  await restored.evaluate(() => {
    const scale = widget.activeChart().getPanes()[0].getMainSourcePriceScale();
    scale.setAutoScale(false);
    scale.setVisiblePriceRange({ from: 4200, to: 4400 });
  });
  const minutesPixels = await magentaPixels();
  assert.ok(
    minutesPixels > hiddenAgainPixels + 500,
    "Same drawing must render on M15 when minutes are enabled and hours disabled",
  );
  console.log("M15_VISIBILITY_PIXELS", { minutesPixels });
  assert.deepEqual(errors, []);
  console.log("DRAWING_VISIBILITY_LAYER_PERSISTED", { visibility, errors });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
