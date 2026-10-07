const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://localhost:16043",
  CHART = process.env.RANGE_CHART || "https://localhost:16044";
const OUT =
  process.env.RANGE_OUTPUT || "/tmp/mw-range-mapping-acceptance/lifecycle.json";
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
    const { ctx, page, host, native, settle, hoverLast, box, state } = fixture;
    await page.mouse.move(10, 10);
    await host.evaluate(async () => {
      widget.setLayout("2h");
      await widget.chart(0).setResolution("60", { doNotActivateChart: true });
      await widget.chart(1).setResolution("1", { doNotActivateChart: true });
    });
    await settle();
    await hoverLast(0);
    const shape = await host.evaluate(async () => {
      const c = widget.chart(0),
        m = c._chartWidget.model().model(),
        bar = MWBarRangeMapping.diagnostics().source;
      return c.createShape(
        {
          time: c._convertIndexToPublicTime(m.mainSeries().bars().lastIndex()),
          price: (bar.high + bar.low) / 2,
        },
        { shape: "horizontal_line" },
      );
    });
    await page.waitForTimeout(2500);
    const drawingState = () =>
      host.evaluate(() => ({
        undo: widget.undoRedoState(),
        charts: Array.from({ length: widget.chartsCount() }, (_, i) =>
          widget
            .chart(i)
            .getAllShapes()
            .map((s) => ({
              id: s.id,
              points: widget.chart(i).getShapeById(s.id).getPoints(),
            })),
        ),
      }));
    await fixture.idle();
    const before = await drawingState();
    const requests = fixture.history;
    await hoverLast(0);
    const b = await box(0);
    for (let i = 0; i < 60; i++)
      await page.mouse.move(
        b.x + b.width * 0.4 + (i % 15) * 6,
        b.y + b.height * 0.5,
      );
    await page.mouse.move(10, 10);
    await page.waitForTimeout(100);
    assert.deepEqual(await drawingState(), before);
    assert.equal(fixture.history, requests);
    const nativeSave = await host.evaluate(
      () => new Promise((resolve) => widget.save(resolve)),
    );
    assert.ok(
      JSON.stringify(nativeSave).includes(shape),
      "user drawing absent in native save",
    );
    report.cases.push({
      phase: "drawing-undo-preserved",
      before,
      after: await drawingState(),
      historyBefore: requests,
      historyAfter: fixture.history,
    });
    // Hold one real save response while ordinary mapping keeps following.
    await page.mouse.move(10, 10);
    await page.waitForTimeout(2500);
    await host.evaluate(
      () =>
        new Promise((resolve, reject) =>
          widget.saveChartToServer(resolve, reject),
        ),
    );
    await host.evaluate(() =>
      MWBarRangeMapping.configure({ style: "rectangle" }),
    );
    await native.locator('[data-name="save-load-menu"]').click();
    assert.notEqual(
      await native
        .locator('[data-name="save-load-menu-item-save"]')
        .getAttribute("aria-disabled"),
      "true",
      "config-only edit left native Save disabled",
    );
    await native.locator('[data-name="save-load-menu"]').click();
    await page.route(
      "**/api/advanced-charts/native-charts/save",
      async (route) => {
        await page.waitForTimeout(500);
        await route.continue();
      },
    );
    const saveRequest = page.waitForRequest(
      (r) => r.url().endsWith("/api/advanced-charts/native-charts/save"),
      { timeout: 15000 },
    );
    const pendingSave = host.evaluate(
      () =>
        new Promise((resolve, reject) =>
          widget.saveChartToServer(resolve, reject),
        ),
    );
    await saveRequest;
    await hoverLast(0);
    await page.mouse.move(10, 10);
    await pendingSave;
    await page.unroute("**/api/advanced-charts/native-charts/save");
    assert.equal(
      (await state()).dirty,
      false,
      "hover during save dirtied workspace",
    );
    assert.deepEqual(await drawingState(), before);
    report.cases.push({
      phase: "hover-during-save",
      dirty: (await state()).dirty,
    });
    // Use the actual native Save As menu rather than overriding save metadata.
    await native.locator('[data-name="save-load-menu"]').click();
    await native.locator('[data-name="save-load-menu-item-clone"]').click();
    const input = native.locator('input[data-qa-id="ui-lib-Input-input"]');
    await input.waitFor();
    await input.fill("Range mapping Save As acceptance");
    await native.locator('button[data-qa-id="save-btn"]').click();
    await input.waitFor({ state: "hidden" });
    await page.waitForTimeout(200);
    const rows = await (
      await ctx.request.get(APP + "/api/advanced-charts/workspaces")
    ).json();
    const copied = rows.find(
      (row) => row.name === "Range mapping Save As acceptance",
    );
    assert.ok(copied);
    assert.notEqual(copied.id, fixture.w.id);
    const savedState =
      typeof copied.document.state.content === "string"
        ? JSON.parse(copied.document.state.content)
        : copied.document.state;
    assert.equal(savedState._mwBarRangeMapping.enabled, true);
    assert.equal(savedState._mwBarRangeMapping.style, "rectangle");
    report.cases.push({
      phase: "save-as-config",
      config: savedState._mwBarRangeMapping,
    });
    await page.mouse.move(10, 10);
    await host.evaluate(
      async ({ id, name }) => {
        await widget.loadChartFromServer({ id, name });
      },
      { id: copied.id, name: copied.name },
    );
    await settle();
    assert.equal((await state()).mapper.source, undefined);
    assert.equal((await state()).config.enabled, true);
    report.cases.push({ phase: "native-load-cleared", state: await state() });
    await hoverLast(0);
    assert.ok((await state()).mapper.source);
    const subscription = await host.evaluate(() => {
      const c = widget.chart(0),
        s = [...subscriptions.values()].find(
          (s) =>
            MWSeries.same(s.symbol, c.symbol()) && s.res === c.resolution(),
        );
      return { listener: s.providerListener };
    });
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.35, b.y + b.height * 0.5, {
      steps: 10,
    });
    assert.equal(
      await host.evaluate(() =>
        MWNativeNavigation.interacting(widget.chart(0)),
      ),
      true,
      "real held drag was not active",
    );
    await page.evaluate(
      ({ chart, subscription }) =>
        document
          .querySelector('iframe[src^="' + chart + '"]')
          .contentWindow.postMessage(
            {
              channel: "mw-chart-v1",
              type: "provider-event",
              event: { ...subscription, type: "reset" },
            },
            chart,
          ),
      { chart: CHART, subscription },
    );
    await page.waitForTimeout(150);
    assert.ok((await state()).mapper.source,"transport reset without confirmed revision must preserve mapping");
    // Native data reset is a proven source replacement, unlike an SSE gap.
    await host.evaluate(listener => [...subscriptions.values()].find(s=>s.providerListener===listener).reset(),subscription.listener);
    await host.waitForFunction(() => !MWBarRangeMapping.diagnostics().source);
    await page.waitForTimeout(100);
    const reset = await state();
    assert.equal(reset.mapper.source, undefined);
    assert.ok(
      !reset.mapper.stores.some((s) => s.key.startsWith("MWP:EURUSD|60|")),
    );
    await page.screenshot({ path: OUT.replace(".json", "-reset-held.png") });
    await page.mouse.up();
    report.cases.push({ phase: "unconfirmed-reset-preserved-native-reset-cleared-during-real-held-drag", state: reset });
    await page.mouse.move(10, 10);
    await host.evaluate(() => MWBarRangeMapping.suspend());
    await page.waitForTimeout(150);
    assert.equal((await state()).mapper.stores.length, 0);
    assert.equal((await state()).mapper.source, undefined);
    report.cases.push({
      phase: "module-suspend-cleared",
      state: await state(),
    });
    await ctx.close();
    assert.deepEqual(report.errors, []);
  } catch (error) {
    report.failure = error.stack;
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
