const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243",
  CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244",
  OUT =
    process.env.RANGE_OUTPUT ||
    "/tmp/mw-sync-settings-implementation/legacy.json";
const report = {
  at: new Date().toISOString(),
  APP,
  CHART,
  cases: [],
  errors: [],
};
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    const f = await require("./fixtures/bar-range-acceptance.cjs")({
      browser,
      report,
      APP,
      CHART,
    });
    let { host, native } = f;
    const { page } = f;
    const baseline = await host.evaluate(
      () => new Promise((resolve) => widget.save(resolve)),
    );
    for (const [date, time] of [
      [true, true],
      [false, true],
      [true, false],
    ]) {
      const legacy = JSON.parse(JSON.stringify(baseline));
      delete legacy._mwSync;
      delete legacy._mwViewports;
      legacy.dateRangeLock = Number(date);
      legacy.trackTimeLock = Number(time);
      legacy._mwBarRangeMapping = {
        version: 1,
        enabled: true,
        style: "rectangle",
      };
      const w = await f.api("advanced-charts/workspaces", {
        name: `Legacy date=${date} time=${time}`,
      });
      await f.api(`advanced-charts/workspaces/${w.id}/save`, {
        name: w.name,
        revision: w.revision,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          symbol: "MWP:EURUSD",
          series_kind: "provider",
          interval: "1M",
          state: legacy,
        },
      });
      await host.evaluate(() => {
        MWSyncCoordinator.configure({
          date: false,
          time: false,
          barWidth: true,
        });
        snapshot();
      });
      await host.waitForFunction(() => !dirty && !nativeSaving, null, {
        timeout: 60000,
      });
      const previousHost = host;
      await host.evaluate(
        ({ id, name }) => widget.loadChartFromServer({ id, name }),
        w,
      );
      await f.settle();
      assert.equal(
        host,
        previousHost,
        "same widget must import old native preferences",
      );
      const s = await host.evaluate(() => ({
        logic: MWSyncCoordinator.snapshot(),
        date: widget.dateRangeSync().value(),
        time: widget.timeSync().value(),
        config: MWBarRangeMapping.snapshot(),
        syncDiagnostics: MWSyncCoordinator.diagnostics(),
        legacyPause: !!widget._mwLegacyPause,
      }));
      report.lastState = s;
      assert.deepEqual(s.logic, { date, time, barWidth: false });
      assert.equal(s.date, date);
      assert.equal(s.time, time);
      assert.equal(s.config.version, 2);
      assert.equal(s.config.enabled, true);
      assert.equal(s.config.style, "rectangle");
      report.cases.push({
        name: "same-widget legacy preference migration",
        date,
        time,
        state: s,
      });
      await f.ctx.unroute("**/api/advanced-charts/workspaces?limit=1");
      await f.ctx.route(
        "**/api/advanced-charts/workspaces?limit=1",
        async (route) => {
          const rows = await (
            await f.ctx.request.get(APP + "/api/advanced-charts/workspaces")
          ).json();
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(rows.filter((row) => row.id === w.id)),
          });
        },
      );
      await page.reload();
      host = undefined;
      for (let i = 0; i < 300 && !host; i++) {
        host = page
          .frames()
          .find((frame) => frame.url().startsWith(CHART + "/"));
        if (!host) await page.waitForTimeout(100);
      }
      f.setHost(host);
      await f.settle();
      native = page.frames().find((frame) => frame.parentFrame() === host);
      assert.deepEqual(
        await host.evaluate(() => MWSyncCoordinator.snapshot()),
        { date, time, barWidth: false },
      );
      report.cases.push({ name: "fresh boot legacy preferences", date, time });
    }
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
        failure: report.failure,
        errors: report.errors,
      }),
    );
    await browser.close();
  }
})();
