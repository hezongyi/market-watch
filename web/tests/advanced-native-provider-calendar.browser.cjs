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
  http: [],
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
    await context.route(
      "**/api/advanced-charts/workspaces?limit=1",
      async (route) => {
        const response = await context.request.get(
          APP + "/api/advanced-charts/workspaces",
        );
        const rows = await response.json();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rows.filter((row) => row.id === w.id)),
        });
      },
    );
    const page = await context.newPage();
    page.on("response", async (r) => {
      if (/\/api\/charts\/(history-loads|data)/.test(r.url())) {
        const body = await r.json().catch(() => null);
        report.http.push({
          status: r.status(),
          query:
            r.request().method() === "POST"
              ? r.request().postDataJSON()?.query
              : undefined,
          detail: body?.detail,
          load: body?.load,
          count: body?.result?.bars?.length,
        });
      }
    });
    page.on("pageerror", (e) => report.errors.push(e.stack));
    await page.goto(APP + "/advanced-charts");
    await page.waitForSelector("iframe");
    let frame;
    for (let n = 0; n < 300 && !frame; n++) {
      frame = page.frames().find((f) => f.url().startsWith(CHART));
      if (!frame) await page.waitForTimeout(100);
    }
    assert.ok(frame);
    const settle = async () => {
      await frame.waitForFunction(
        () =>
          typeof ready !== "undefined" &&
          ready &&
          !loading &&
          !historyReloading &&
          !rangeGuard.busy() &&
          !edgeGuard.busy() &&
          !MWNativeNavigation.busy() &&
          widget.activeChart().dataReady(),
        null,
        { timeout: 120000 },
      );
      await frame.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.waitForTimeout(500);
    };
    await settle();
    await frame.evaluate(() => {
      widget.timeSync().setValue(false);
      widget.dateRangeSync().setValue(false);
      widget.crosshairSync().setValue(false);
      globalThis.__calendarCallbacks = [];
      const getBars = feed.getBars;
      feed.getBars = function (s, r, p, cb, err) {
        return getBars.call(
          this,
          s,
          r,
          p,
          (bars, meta) => {
            __calendarCallbacks.push({
              symbol: s.ticker,
              res: r,
              request: p,
              first: bars[0]?.time,
              last: bars.at(-1)?.time,
              count: bars.length,
              times: bars.slice(-300).map((b) => b.time),
              march: bars
                .filter(
                  (b) =>
                    b.time >= Date.parse("2024-03-07") &&
                    b.time < Date.parse("2024-03-15"),
                )
                .map((b) => b.time),
              meta,
            });
            cb(bars, meta);
          },
          err,
        );
      };
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
        (range) =>
          widget
            .activeChart()
            .setVisibleRange(range, { rejectByTimeout: 120000 }),
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
            callbacks: __calendarCallbacks.filter(
              (p) => p.res === c.resolution(),
            ),
          };
        }),
      );
      assert.ok(report.cases.at(-1).range.to > report.cases.at(-1).range.from);
      assert.equal(report.cases.at(-1).invalid, false);
      const actual = report.cases.at(-1);
      actual.requested = range;
      assert.ok(
        actual.range.from <= range.to && actual.range.to >= range.from,
        "native navigation must reach the requested historical calendar range",
      );
      assert.ok(
        actual.callbacks.some((p) => p.count > 0),
        "actual native callbacks must deliver calendar bars",
      );
      for (const callback of actual.callbacks) {
        assert.equal(new Set(callback.times).size, callback.times.length);
        assert.ok(
          callback.times.every((t, i) => i === 0 || t > callback.times[i - 1]),
          "bars remain ordered",
        );
        if (["1D", "1W", "1M"].includes(res))
          assert.ok(
            callback.times.every((t) => t % 86400000 === 0),
            "D/W/M chart labels use UTC midnight",
          );
      }
      if (["240", "1D"].includes(res)) {
        const march = new Set(actual.callbacks.flatMap((c) => c.march));
        const has = (iso) => march.has(Date.parse(iso));
        if (SYMBOL === "EURUSD" && res === "240") {
          assert.ok(
            has("2024-03-08T14:00:00Z") && has("2024-03-11T13:00:00Z"),
            "OANDA NY17 H4 opens shift UTC hour across DST",
          );
        }
        if (res === "1D") {
          assert.ok(
            has("2024-03-08") && has("2024-03-11"),
            "daily date labels preserve trading dates across DST",
          );
          if (SYMBOL === "BTCUSDT")
            assert.ok(
              has("2024-03-09") && has("2024-03-10"),
              "crypto preserves weekend dates",
            );
          else
            assert.ok(
              !has("2024-03-09") && !has("2024-03-10"),
              "FX/equities omit closed weekends",
            );
        }
        actual.dstChecked = true;
      }
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
