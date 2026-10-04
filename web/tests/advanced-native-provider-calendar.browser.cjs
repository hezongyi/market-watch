const { chromium } = require("@playwright/test");
const fs = require("fs"),
  assert = require("assert/strict");
const APP = process.env.NATIVE_SYNC_APP || "https://localhost:15843",
  CHART = process.env.NATIVE_SYNC_CHART || "https://localhost:15844";
const OUT =
  process.env.NATIVE_CALENDAR_OUTPUT ||
  "/tmp/mw-chart-sync-acceptance/provider-calendar.json";
const SYMBOL = process.env.NATIVE_CALENDAR_SYMBOL || "EURUSD";
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
        symbol: "MWP:" + SYMBOL,
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
          widget.activeChart().dataReady(),
        null,
        { timeout: 45000 },
      );
    await settle();
    await frame.evaluate(() => {
      widget.timeSync().setValue(false);
      widget.dateRangeSync().setValue(false);
      widget.crosshairSync().setValue(false);
    });
    for (const res of (
      process.env.NATIVE_CALENDAR_RESOLUTIONS || "1,5,15,30,60,240,1D,1W,1M"
    ).split(",")) {
      await frame.evaluate(
        (res) =>
          widget.activeChart().setResolution(res, { doNotActivateChart: true }),
        res,
      );
      await settle();
      const from = Date.parse("2024-03-08T00:00:00Z") / 1000,
        to = Date.parse("2024-03-14T00:00:00Z") / 1000;
      const range =
        res === "1"
          ? {
              from: Date.parse("2024-03-11T20:00:00Z") / 1000,
              to: Date.parse("2024-03-11T23:00:00Z") / 1000,
            }
          : ["1W", "1M"].includes(res)
            ? {
                from: Date.parse("2020-01-01") / 1000,
                to: Date.parse("2021-01-01") / 1000,
              }
            : { from, to };
      await frame.evaluate(
        (range) => widget.activeChart().setVisibleRange(range),
        range,
      );
      await settle();
      report.cases.push(
        await frame.evaluate(() => {
          const c = widget.activeChart(),
            m = c._chartWidget.model().model();
          return {
            symbol: c.symbol(),
            res: c.resolution(),
            range: c.getVisibleRange(),
            status: m.mainSeries().status(),
            invalid: m.mainSeries().isSymbolInvalid(),
            window: MWNativeNavigation.chartWindow(c),
            points: m.timeScale().points().range().value(),
          };
        }),
      );
      assert.ok(report.cases.at(-1).range.to > report.cases.at(-1).range.from);
      assert.equal(report.cases.at(-1).invalid, false);
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    }
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
