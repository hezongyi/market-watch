// Isolated product API/PG and actual provider candles; real mouse interaction.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://localhost:16043",
  CHART = process.env.RANGE_CHART || "https://localhost:16044";
const OUT =
  process.env.RANGE_OUTPUT ||
  "/tmp/mw-range-mapping-acceptance/navigation.json";
const report = { at: new Date().toISOString(), cases: [], errors: [] };
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    const fixture = await require("./fixtures/bar-range-acceptance.cjs")({
      browser,
      report,
      APP,
      CHART,
    });
    const { ctx, api, w, page, native, settle, box, hoverLast, state } =
      fixture;
    let { host } = fixture;
    await hoverLast(0);
    report.cases.push({ phase: "month-hover", state: await state() });
    assert.ok(
      report.cases.at(-1).state.mapper.source,
      "valid month source missing",
    );
    assert.ok(
      report.cases.at(-1).state.paints.some((v) => v.resolution === "5"),
      "M5 not painted",
    );
    assert.ok(
      report.cases.at(-1).state.paints.some((v) => v.resolution === "1D"),
      "D1 not painted",
    );
    assert.ok(
      !report.cases.at(-1).state.paints.some((v) => v.resolution === "1W"),
      "MN painted W1",
    );
    await page.screenshot({ path: OUT.replace(".json", "-month.png") });
    const before = await state(),
      requests = fixture.history,
      b = await box(0);
    for (let n = 0; n < 30; n++)
      await page.mouse.move(
        b.x + b.width * 0.45 + n * 3,
        b.y + b.height * 0.55,
      );
    await page.waitForTimeout(500);
    const after = await state();
    report.cases.push({
      phase: "continuous",
      before,
      after,
      historyBefore: requests,
      historyAfter: fixture.history,
    });
    assert.deepEqual(after.charts, before.charts, "mapping modified geometry");
    assert.equal(fixture.history, requests, "hover added historical requests");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(80);
    assert.equal((await state()).mapper.source, undefined);
    report.cases.push({ phase: "leave", state: await state() });
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    await native.locator('[data-name="mw-sync-settings"]').click();
    await native.locator('[data-name="mw-sync-settings-dialog"] select[name="style"]').selectOption('rectangle');
    await native.locator('[data-name="mw-sync-settings-dialog"] [data-action="confirm"]').click();
    await hoverLast(0);
    report.cases.push({ phase: "rectangle", state: await state() });
    await page.screenshot({ path: OUT.replace(".json", "-rectangle.png") });
    await hoverLast(2);
    assert.equal((await state()).mapper.source.resolution, "5");
    report.cases.push({ phase: "switch-source", state: await state() });
    const dragBox = await box(2);
    await page.mouse.move(
      dragBox.x + dragBox.width * 0.6,
      dragBox.y + dragBox.height * 0.5,
    );
    await page.mouse.down();
    await page.mouse.move(
      dragBox.x + dragBox.width * 0.25,
      dragBox.y + dragBox.height * 0.5,
      { steps: 40 },
    );
    await page.screenshot({ path: OUT.replace(".json", "-held.png") });
    await page.mouse.up();
    await settle();
    report.cases.push({ phase: "held-drag", state: await state() });

    await page.mouse.move(10, 10);
    await host.evaluate(async () => {
      widget.setLayout("2h");
      MWBarRangeMapping.configure({ style: "background" });
      await widget.chart(0).setResolution("1W", { doNotActivateChart: true });
      await widget.chart(1).setResolution("5", { doNotActivateChart: true });
      widget.timeSync().setValue(false);
    });
    await settle();
    // Keep the semantic projection case within the default continuous-history
    // budget; capacity clamping itself has separate native acceptance coverage.
    const target = Date.parse("2025-12-01") / 1000;
    await host.evaluate(
      (target) =>
        widget.chart(0).setVisibleRange({
          from: target - 16 * 86400,
          to: target + 16 * 86400,
        }),
      target,
    );
    await settle();
    await host.evaluate(() => {
      widget.timeSync().setValue(true);
      __rangePaints.length = 0;
    });
    const navigationBox = await box(0),
      x = await host.evaluate((target) => {
        const c = widget.chart(0),
          ts = c._chartWidget.model().model().timeScale();
        return ts.indexToCoordinate(ts.timePointToIndex(target, 0));
      }, target);
    await page.mouse.move(
      navigationBox.x + x,
      navigationBox.y + navigationBox.height * 0.55,
    );
    await page.mouse.down();
    await page.mouse.up();
    await settle();
    await page.waitForTimeout(250);
    const stationary = await state();
    report.stationary = stationary;
    assert.equal(stationary.mapper.source?.resolution, "1W");
    assert.ok(stationary.mapper.source.start < Date.parse("2025-12-07"));
    assert.ok(
      stationary.paints.some((p) => p.resolution === "5"),
      "navigation completed without range reproject",
    );
    report.cases.push({ phase: "stationary-navigation", state: stationary });
    await page.screenshot({ path: OUT.replace(".json", "-stationary.png") });
    // Keep the pointer stationary until after the evidence above.
    await page.mouse.move(10, 10);
    await host.evaluate(() =>
      widget.chart(1).setVisibleRange({
        from: Date.parse("2023-03-06") / 1000,
        to: Date.parse("2023-03-07") / 1000,
      }),
    );
    await settle();
    assert.equal((await state()).mapper.source, undefined);
    report.cases.push({
      phase: "leave-before-navigation",
      state: await state(),
    });
    await ctx.close();
    assert.deepEqual(report.errors, []);
  } catch (e) {
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await browser.close();
    console.log(
      JSON.stringify({
        cases: report.cases.length,
        errors: report.errors,
        failure: report.failure,
      }),
    );
  }
})();
