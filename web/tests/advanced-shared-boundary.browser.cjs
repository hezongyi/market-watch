// Real licensed native engine, synthetic 24x7 bars and public navigation APIs.
// No app server, credentials, persistence or licensed asset modification.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../advanced-host");
const origin = "https://shared-boundary.test";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.MW_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.MW_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const cases = [];
  try {
    for (const supplierFailure of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort();
          if (url.pathname === "/")
            return route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: '<!doctype html><meta charset="utf-8"><style>html,body,#chart{height:100%;margin:0}</style><div id="chart"></div><script src="/charting_library/charting_library.js"></script><script src="/native-navigation.js"></script>',
            });
          const file = path.resolve(root, "." + url.pathname);
          if (!file.startsWith(root + "/") || !fs.existsSync(file))
            return route.fulfill({ status: 404, body: "" });
          const type = file.endsWith(".js")
            ? "application/javascript; charset=utf-8"
            : file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".html")
                ? "text/html; charset=utf-8"
                : "application/octet-stream";
          return route.fulfill({
            contentType: type,
            body: fs.readFileSync(file),
          });
        });
        await page.goto(origin);
        await page.evaluate((supplierFailure) => {
          globalThis.chartReady = false;
          globalThis.trace = [];
          globalThis.notices = [];
          globalThis.fills = [];
          globalThis.boundThreads = [];
          globalThis.failNative = false;
          addEventListener("mw-capacity-state", (event) =>
            notices.push(event.detail),
          );
          const bind = MWNativeNavigation.bindThread;
          MWNativeNavigation.bindThread = function (thread, resolution) {
            boundThreads.push(thread);
            return bind.call(this, thread, resolution);
          };
          const end = Math.floor(Date.now() / 300000) * 300000;
          const bars = (p) =>
            Array.from({ length: p.countBack }, (_, i) => ({
              time:
                (Math.min(Math.floor(p.to / 300) * 300, end / 1000) -
                  (p.countBack - i) * 300) *
                1000,
              open: 1.1,
              high: 1.2,
              low: 1,
              close: 1.15,
            }));
          const failure = (message) =>
            Object.assign(Error(message), {
              code: "HISTORY_PROVIDER_FAILED",
              status: 503,
            });
          const feed = {
            onReady: (cb) =>
              setTimeout(() => cb({ supported_resolutions: ["5"] }), 0),
            resolveSymbol: (name, cb) =>
              setTimeout(
                () =>
                  cb({
                    name,
                    ticker: name,
                    description: name,
                    type: "forex",
                    session: "24x7",
                    timezone: "Etc/UTC",
                    minmov: 1,
                    pricescale: 100000,
                    has_intraday: true,
                    supported_resolutions: ["5"],
                    data_status: "streaming",
                  }),
                0,
              ),
            getServerTime: (cb) => cb(end / 1000),
            subscribeBars() {},
            unsubscribeBars() {},
            getBars: (symbol, resolution, p, cb, err) => {
              trace.push({ ...p });
              if (p.mw_boundaryId)
                fills.push(() => {
                  if (!supplierFailure) cb(bars(p), { noData: false });
                  else if (p.mw_boundaryBatch === 1)
                    cb(bars(p).slice(-10), { noData: false });
                  else err(failure("boundary supplier unavailable"));
                });
              else
                setTimeout(
                  () =>
                    failNative
                      ? err(failure("promotion supplier unavailable"))
                      : cb(bars(p), { noData: false }),
                  0,
                );
            },
          };
          MWNativeNavigation.setCapabilities({
            protocol: 1,
            mode: "continuous",
            max_bars: 20000,
            workspace_bars: 80000,
            response_bytes: 128 * 1024 * 1024,
            task_seconds: 30,
          });
          globalThis.widget = new TradingView.widget({
            container: "chart",
            library_path: "/charting_library/",
            symbol: "MWP:EURUSD",
            interval: "5",
            locale: "zh",
            datafeed: feed,
            autosize: true,
            disabled_features: ["use_localstorage_for_settings"],
            enabled_features: ["support_multicharts"],
          });
          widget.onChartReady(() => {
            chartReady = true;
            widget.timeSync().setValue(false);
            widget.dateRangeSync().setValue(false);
            widget.symbolSync().setValue(false);
            widget.setLayout("2h");
          });
        }, supplierFailure);
        await page.waitForFunction(
          () =>
            chartReady &&
            widget.chartsCount() === 2 &&
            [0, 1].every((i) => widget.chart(i).dataReady()),
          null,
          { timeout: 30000 },
        );
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => {
          const diag = MWNativeNavigation.diagnostics();
          const ts = widget.chart(0)._chartWidget.model().model().timeScale();
          const target =
            ts.points().valueAt(ts.points().range().value().firstIndex) -
            10000 * 300;
          MWNativeNavigation.setCapabilities({
            ...diag.limits,
            max_bars: diag.resident + 200,
            workspace_bars: (diag.resident + 200) * 4,
          });
          globalThis.navResults = [0, 1].map((i) =>
            widget
              .chart(i)
              .setVisibleRange(
                { from: target, to: target + 100 * 300 },
                { rejectByTimeout: 20000 },
              )
              .catch(String),
          );
          return { diag, target };
        });
        await page.waitForFunction(
          () =>
            fills.length > 0 &&
            MWNativeNavigation.diagnostics().cursors.filter(
              (s) => s.phase === "loading",
            ).length === 2,
          null,
          { timeout: 10000 },
        );
        await page.evaluate(() =>
          widget.chart(0).executeActionById("timeScaleReset"),
        );
        const resetRange = await page.evaluate(() =>
          widget.chart(0).getVisibleRange(),
        );
        await page.evaluate((fail) => {
          failNative = fail;
          fills.shift()();
        }, supplierFailure);
        if (supplierFailure) {
          await page.waitForFunction(() => fills.length > 0);
          await page.evaluate(() => fills.shift()());
        }
        await page.waitForFunction(
          () => notices.some((n) => n.phase === "limited"),
          null,
          { timeout: 10000 },
        );
        const after = await page.evaluate(() => ({
          diag: MWNativeNavigation.diagnostics(),
          cacheFirst: boundThreads[0]._cache.bars[0].time / 1000,
          pendingSubscribers: boundThreads[0]._pendingSubscribers.length,
          ranges: [0, 1].map((i) => widget.chart(i).getVisibleRange()),
          notices,
          trace,
        }));
        const notice = after.notices
          .filter((n) => n.phase === "limited")
          .at(-1);
        assert.equal(
          after.diag.resident,
          before.diag.resident + (supplierFailure ? 10 : 200),
        );
        assert.equal(after.diag.pending, 0);
        assert.equal(
          after.pendingSubscribers,
          0,
          "native delivery queue resumes after fill",
        );
        assert.ok(after.diag.cursors.every((s) => s.phase === "idle"));
        assert.deepEqual(
          after.ranges[0],
          resetRange,
          "peer completion preserves the reset pane",
        );
        assert.ok(after.ranges[1].to < after.ranges[0].to);
        assert.equal(after.ranges[1].from, notice.actual);
        assert.ok(
          notice.actual >= after.cacheFirst &&
            notice.actual <= after.cacheFirst + 4 * 300,
          "promotion reaches the earliest cached point with only the native calculation prefix",
        );
        if (supplierFailure)
          assert.match(notice.message, /现有数据边界.*未完成/);
        else assert.match(notice.message, /容量可到达/);
        assert.deepEqual(errors, []);
        cases.push({ passed: true, supplierFailure, before, after });
      } finally {
        await context.close();
      }
    }
    if (process.env.MW_SHARED_BOUNDARY_REPORT)
      fs.writeFileSync(
        process.env.MW_SHARED_BOUNDARY_REPORT,
        JSON.stringify(
          {
            scope:
              "real native engine, synthetic bars, public operations; no deployed instance",
            cases,
          },
          null,
          2,
        ),
      );
    console.log(
      "Real native shared boundary: cancellation, complete cache promotion and supplier failure passed",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
