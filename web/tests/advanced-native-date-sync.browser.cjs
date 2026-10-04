const { chromium } = require("@playwright/test");
const fs = require("fs"),
  assert = require("assert/strict");
const APP = process.env.NATIVE_SYNC_APP || "https://localhost:15843",
  CHART = process.env.NATIVE_SYNC_CHART || "https://localhost:15844";
const OUT =
  process.env.NATIVE_DATE_SYNC_OUTPUT ||
  "/tmp/mw-chart-sync-acceptance/date-sync.json";
const report = {
  scope: "isolated Docker actual provider native calendar",
  cases: [],
  errors: [],
};
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    });
    const login = await context.request.post(APP + "/api/login", {
      data: JSON.parse(
        fs.readFileSync(
          process.env.NATIVE_SYNC_LOGIN ||
            "/tmp/mw-chart-sync-acceptance/login.json",
        ),
      ),
    });
    assert.ok(login.ok());
    const { csrf } = await login.json();
    const api = async (path, data) => {
      const r = await context.request.post(APP + "/api/" + path, {
        data,
        headers: { "X-CSRF-Token": csrf },
      });
      assert.ok(r.ok(), path + " " + r.status());
      return r.json();
    };
    const w = await api("advanced-charts/workspaces", {
      name: "real provider calendar",
    });
    await api("advanced-charts/workspaces/" + w.id + "/save", {
      name: w.name,
      revision: w.revision,
      document: {
        engine: "tv31",
        schemaVersion: 1,
        symbol: "MWP:EURUSD",
        series_kind: "provider",
        interval: "240",
      },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(e.stack));
    await page.goto(APP + "/advanced-charts");
    await page.waitForSelector("iframe");
    let frame;
    for (let n = 0; n < 300 && !frame; n++) {
      frame = page.frames().find((f) => f.url().startsWith(CHART));
      if (!frame) await page.waitForTimeout(100);
    }
    assert.ok(frame);
    const settle = () =>
      frame.waitForFunction(
        () =>
          typeof ready !== "undefined" &&
          ready &&
          !loading &&
          !rangeGuard.busy() &&
          !edgeGuard.busy() &&
          !MWNativeNavigation.busy() &&
          Array.from({ length: widget.chartsCount() }, (_, i) =>
            widget.chart(i).dataReady(),
          ).every(Boolean),
        null,
        { timeout: 45000 },
      );
    await settle();
    await frame.evaluate(() => {
      widget.timeSync().setValue(false);
      widget.dateRangeSync().setValue(false);
      widget.crosshairSync().setValue(false);
    });
    await frame.evaluate(async () => {
      widget.setLayout("2h");
    });
    await frame.waitForFunction(() => widget.chartsCount() === 2);
    await settle();
    await frame.evaluate(async () => {
      widget.dateRangeSync().setValue(false);
      widget.timeSync().setValue(false);
      await widget.chart(1).setResolution("5", { doNotActivateChart: true });
    });
    await settle();
    await frame.evaluate(async () => {
      await widget.chart(0).setResolution("5", { doNotActivateChart: true });
      widget.dateRangeSync().setValue(true);
      widget.timeSync().setValue(true);
      await widget
        .chart(0)
        .setVisibleRange({
          from: Date.parse("2024-03-11T20:00:00Z") / 1000,
          to: Date.parse("2024-03-11T23:00:00Z") / 1000,
        });
    });
    await settle();
    const state = await frame.evaluate(() => captureChartLayout(widget));
    report.before = await frame.evaluate(() => ({
      ranges: captureChartViewports(widget),
      date: widget.dateRangeSync().value(),
      time: widget.timeSync().value(),
    }));
    await settle();
    await page.waitForTimeout(1000);
    await frame.evaluate(
      () =>
        new Promise((ok, fail) =>
          widget.saveChartToServer(ok, (e) => fail(Error(JSON.stringify(e)))),
        ),
    );
    await page.reload();
    frame = undefined;
    for (let n = 0; n < 300 && !frame; n++) {
      frame = page.frames().find((f) => f.url().startsWith(CHART));
      if (!frame) await page.waitForTimeout(100);
    }
    assert.ok(frame);
    await settle();
    report.after = await frame.evaluate(() => ({
      ranges: captureChartViewports(widget),
      date: widget.dateRangeSync().value(),
      time: widget.timeSync().value(),
    }));
    assert.equal(report.after.date, true);
    assert.equal(report.after.time, true);
    for (let i = 0; i < 2; i++)
      for (const edge of ["from", "to"])
        assert.ok(
          Math.abs(
            report.before.ranges[i].range[edge] -
              report.after.ranges[i].range[edge],
          ) <= 300,
        );
    assert.equal(
      report.before.ranges[0].spacing,
      report.after.ranges[0].spacing,
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
    await context.close();
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch((e) => {
  report.error = String(e);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.error(e);
  process.exitCode = 1;
});
