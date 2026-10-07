const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243",
  CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244",
  OUT =
    process.env.RANGE_OUTPUT ||
    "/tmp/mw-sync-settings-implementation/touch.json";
const report = { at: new Date().toISOString(), cases: [], errors: [] };
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    const proxy = {
      newContext: (options) =>
        browser.newContext({ ...options, hasTouch: true }),
    };
    const f = await require("./fixtures/bar-range-acceptance.cjs")({
      browser: proxy,
      report,
      APP,
      CHART,
    });
    const { host, page, native } = f;
    const record = (name, data) => report.cases.push({ name, ...data });
    await host.evaluate(() =>
      MWSyncCoordinator.configure({ date: false, time: false, barWidth: true }),
    );
    const b = await f.box(0);
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.85);
    const hint = native.getByRole("button", { name: "了解!", exact: true });
    if (await hint.isVisible()) await hint.click();
    const spacing = () =>
      host.evaluate(() =>
        Array.from({ length: widget.chartsCount() }, (_, i) =>
          widget.chart(i).getTimeScale().barSpacing(),
        ),
      );
    const before = await spacing(),
      session = await f.ctx.newCDPSession(page);
    await session.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 2,
    });
    const x = b.x + b.width * 0.5,
      y = b.y + b.height * 0.75;
    const points = (d) => [
      { x: x - d, y, id: 1 },
      { x: x + d, y, id: 2 },
    ];
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(40),
    });
    for (const d of [45, 50, 55, 60, 65, 70]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(d),
      });
      await page.waitForTimeout(30);
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(350);
    const after = await spacing();
    assert.notEqual(after[0], before[0]);
    assert.ok(after.every((v) => Math.abs(v - after[0]) < 1e-6));
    record("trusted two-finger pinch", { before, after });
    await host.evaluate(() => {
      widget.chart(0).getTimeScale().setBarSpacing(6);
      MWSyncCoordinator.configure({ date: false, time: false, barWidth: true });
    });
    await page.mouse.move(x, y);
    await page.mouse.wheel(120, 0);
    await page.waitForTimeout(200);
    const pan = await spacing();
    assert.notEqual(pan[0], pan[1]);
    record("horizontal trackpad pan excluded", { pan });
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(300);
    const wheel = await spacing();
    assert.ok(wheel.every((v) => Math.abs(v - wheel[0]) < 1e-6));
    record("vertical trackpad wheel follows", { wheel });
    // Read-only view is the application's supported mobile presentation.
    await page.setViewportSize({ width: 600, height: 900 });
    await page.waitForTimeout(500);
    report.mobile = await host.evaluate(() => ({
      nativeReadonly,
      charts: widget.chartsCount(),
    }));
    assert.equal(report.mobile.nativeReadonly, true);
    record("mobile view state", { state: report.mobile });
    const storedBefore = (
      await (
        await f.ctx.request.get(APP + "/api/advanced-charts/workspaces")
      ).json()
    ).find((r) => r.id === f.w.id);
    let writes = [];
    page.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().includes("/api/advanced-charts/") &&
        !r.url().includes("/preferences")
      )
        writes.push(r.url());
    });
    await host.evaluate(() => {
      MWBarRangeMapping.configure({
        style: "rectangle",
        colorMode: "custom",
        color: "#ABCDEF",
      });
      snapshot();
      autoSave.select(true);
    });
    await page.waitForTimeout(1500);
    const storedAfter = (
      await (
        await f.ctx.request.get(APP + "/api/advanced-charts/workspaces")
      ).json()
    ).find((r) => r.id === f.w.id);
    assert.deepEqual(storedAfter, storedBefore);
    assert.deepEqual(writes, []);
    record("readonly temporary config and save do not write server", {
      writes,
      revision: storedAfter.revision,
    });
    await host.evaluate(() => {
      MWSyncCoordinator.dispose();
      MWBarRangeMapping.dispose();
    });
    const cleanup = await host.evaluate(() => ({
      sync: MWSyncCoordinator.diagnostics(),
      mapping: MWBarRangeMapping.diagnostics(),
      rails: widget
        .chart(0)
        ._chartWidget.ownerDocument()
        .querySelectorAll('[data-name="mw-range-price-rail"]').length,
    }));
    assert.equal(cleanup.sync.bindings, 0);
    assert.equal(cleanup.sync.pauses, 0);
    assert.equal(cleanup.mapping.bindings, 0);
    assert.equal(cleanup.mapping.rails, 0);
    assert.equal(cleanup.mapping.labelPanes, 0);
    assert.equal(cleanup.rails, 0);
    record("actual native dispose cleanup", { cleanup });
    assert.deepEqual(report.errors, []);
    await f.ctx.close();
  } catch (e) {
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        cases: report.cases.length,
        last: report.cases.at(-1)?.name,
        failure: report.failure,
        errors: report.errors,
      }),
    );
    await browser.close();
  }
})();
