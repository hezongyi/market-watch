const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "../../advanced-host"),
  BASE = "https://native-navigation.test",
  OUT =
    process.env.NATIVE_NAVIGATION_OUTPUT || "/tmp/mw-native-navigation.json";
(async () => {
  const result = {
    scope:
      "Isolated real v31.1 library with synthetic 24x7 OHLC; no production API or user-state writes",
    cases: [],
    errors: [],
  };
  const B = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const config of process.env.NATIVE_NAVIGATION_COLD
      ? [
          {
            source: "1W",
            peers: ["1D", "240", "5"],
            kind: "crosshair",
            ratio: 0.88,
            cold: true,
          },
        ]
      : process.env.NATIVE_NAVIGATION_MATRIX === "all"
        ? [
            { source: "1W", peers: ["1", "5", "15"], kind: "far", ratio: 0.15 },
            {
              source: "1W",
              peers: ["30", "60", "240"],
              kind: "far",
              ratio: 0.15,
            },
            {
              source: "1M",
              peers: ["1D", "1W", "240"],
              kind: "crosshair",
              ratio: 0.12,
            },
          ]
        : [
            {
              source: "1W",
              peers: ["1D", "240", "5"],
              kind: "crosshair",
              ratio: 0.88,
            },
            { source: "1W", peers: ["1", "5", "15"], kind: "far", ratio: 0.15 },
          ]) {
      const C = await B.newContext({ viewport: { width: 2000, height: 1100 } });
      const P = await C.newPage();
      const row = { config, errors: [] };
      result.cases.push(row);
      P.on("pageerror", (e) => row.errors.push(e.stack));
      await C.route("**/*", async (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== BASE) return route.abort();
        if (u.pathname === "/navigation")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html><head><style>html,body,#chart{height:100%;margin:0}</style></head><body><div id="chart"></div><script src="/charting_library/charting_library.js"></script><script src="/native-navigation.js"></script></body></html>',
          });
        if (u.pathname === "/native-navigation.js")
          return route.fulfill({
            contentType: "application/javascript",
            body: fs.readFileSync(path.join(ROOT, "native-navigation.js")),
          });
        if (!u.pathname.startsWith("/charting_library/")) return route.abort();
        const p = path.resolve(ROOT, "." + u.pathname);
        if (!p.startsWith(ROOT + "/charting_library/") || !fs.existsSync(p))
          return route.fulfill({ status: 404, body: "" });
        let b = fs.readFileSync(p);
        if (u.pathname.includes("/bundles/library.")) {
          let s = b.toString();
          const a = "s&&this._drawSources(e,t)}if(null!==this._state)";
          assert.equal(s.split(a).length, 2);
          s = s.replace(
            a,
            "s&&(this._drawSources(e,t),(()=>{const m=this.state().model();if(!this.containsMainSeries())return;(globalThis.__navigationModels??=new Map).set(m.id(),{m,canvas:e.canvas});})())}if(null!==this._state)",
          );
          b = Buffer.from(s);
        }
        const type = p.endsWith(".js")
          ? "application/javascript"
          : p.endsWith(".css")
            ? "text/css"
            : p.endsWith(".html")
              ? "text/html"
              : p.endsWith(".svg")
                ? "image/svg+xml"
                : p.endsWith(".png")
                  ? "image/png"
                  : "application/octet-stream";
        return route.fulfill({ contentType: type, body: b });
      });
      await P.goto(BASE + "/navigation");
      await P.evaluate(({ source, peers, cold }) => {
        globalThis.trace = [];
        globalThis.injectFailure = cold ? source : null;
        globalThis.stage = "initial";
        globalThis.resetCallbacks = new Map();
        const end = Date.parse("2026-10-01T00:00:00Z"),
          resolutions = ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"];
        const stepOf = (r) =>
          r === "1D"
            ? 86400000
            : r === "1W"
              ? 7 * 86400000
              : r === "1M"
                ? 30 * 86400000
                : Number(r) * 60000;
        const feed = {
          onReady: (cb) =>
            setTimeout(() => cb({ supported_resolutions: resolutions }), 0),
          resolveSymbol: (s, cb) =>
            setTimeout(
              () =>
                cb({
                  name: s,
                  ticker: s,
                  description: s,
                  type: "crypto",
                  exchange: "TEST",
                  listed_exchange: "TEST",
                  session: "24x7",
                  timezone: "Etc/UTC",
                  minmov: 1,
                  pricescale: 100,
                  has_intraday: true,
                  has_daily: true,
                  has_weekly_and_monthly: true,
                  intraday_multipliers: ["1", "5", "15", "30", "60", "240"],
                  daily_multipliers: ["1"],
                  weekly_multipliers: ["1"],
                  monthly_multipliers: ["1"],
                  supported_resolutions: resolutions,
                  format: "price",
                  data_status: "streaming",
                }),
              0,
            ),
          getServerTime: (cb) => cb(end / 1000),
          getBars: (s, r, p, cb, err) => {
            const entry = { r, stage, params: { ...p }, at: performance.now() };
            trace.push(entry);
            if (globalThis.injectFailure === r) {
              injectFailure = null;
              entry.error = "injected HTTP 503";
              setTimeout(
                () =>
                  err(
                    Object.assign(Error(entry.error), {
                      code: "HISTORY_BUSY",
                      status: 503,
                    }),
                  ),
                0,
              );
              return;
            }
            if (p.countBack > 20000) {
              entry.error = "请求不在允许范围内";
              setTimeout(() => err(entry.error), 0);
              return;
            }
            const step = stepOf(r),
              n = p.countBack + 300,
              last = Math.min(
                end - step,
                Math.floor((p.to * 1000 - 1) / step) * step,
              );
            const bars = Array.from({ length: n }, (_, i) => {
              const time = last - (n - 1 - i) * step,
                v = 100 + Math.sin(time / step) * 2;
              return { time, open: v, high: v + 1, low: v - 1, close: v + 0.4 };
            });
            setTimeout(() => cb(bars, { noData: false }), 0);
          },
          subscribeBars: (s, r, cb, id, reset) => resetCallbacks.set(r, reset),
          unsubscribeBars: () => {},
        };
        globalThis.widget = new TradingView.widget({
          container: "chart",
          library_path: "/charting_library/",
          symbol: "MWP:TEST24",
          interval: source,
          datafeed: feed,
          locale: "zh",
          autosize: true,
          enabled_features: [
            "support_multicharts",
            "determine_first_data_request_size_using_visible_range",
          ],
          disabled_features: [
            "use_localstorage_for_settings",
            "header_widget",
            "left_toolbar",
            "create_volume_indicator_by_default",
            "trading_account_manager",
          ],
        });
        globalThis.ready = false;
        widget.onChartReady(() => (ready = true));
      }, config);
      await P.waitForFunction(
        (cold) => ready && (cold || widget.activeChart().dataReady()),
        config.cold,
        { timeout: 15000 },
      );
      if (config.cold) {
        await P.waitForTimeout(300);
        row.cold = await P.evaluate(() => {
          const m = widget.activeChart()._chartWidget.model().model();
          return {
            status: m.mainSeries().status(),
            invalid: m.mainSeries().isSymbolInvalid(),
            requesting: m.timeScale()._requestingMoreData,
          };
        });
        fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
        assert.equal(
          row.cold.invalid,
          false,
          "503 must not produce invalid-symbol series status",
        );
        assert.equal(
          row.cold.requesting,
          false,
          "cold error left the time axis loading",
        );
        await P.evaluate(() => widget.activeChart().resetData());
        await P.waitForFunction(
          () =>
            widget.activeChart().dataReady() &&
            widget.activeChart().getVisibleRange().to > 0,
        );
        row.coldRecovered = await P.evaluate(() =>
          widget.activeChart().getVisibleRange(),
        );
      }
      if (process.env.NATIVE_NAVIGATION_CANCEL) {
        row.nativeCancellation = await P.evaluate(async () => {
          const results = [];
          MWNativeNavigation.configure(
            () => new Promise((resolve) => setTimeout(resolve, 350)),
          );
          for (const kind of ["future-margin", "near-history"]) {
            const c = widget.activeChart(),
              m = c._chartWidget.model().model();
            const ts = m.timeScale(),
              points = ts.points().range().value();
            const first = ts.points().valueAt(points.firstIndex);
            const last = ts.points().valueAt(points.lastIndex);
            const remote = c
              .setVisibleRange({
                from: Date.UTC(2000, 0, 1) / 1000,
                to: Date.UTC(2000, 1, 1) / 1000,
              })
              .then(
                () => false,
                (error) => error.code === "HISTORY_CANCELLED",
              );
            await new Promise((resolve) => setTimeout(resolve, 50));
            await m.gotoTime(
              (kind === "future-margin" ? last + 604800 : first - 604800) *
                1000,
            );
            results.push({
              kind,
              cancelled: await remote,
              hasWindow: !!MWNativeNavigation.chartWindow(c),
            });
          }
          MWNativeNavigation.configure(undefined);
          return results;
        });
        for (const result of row.nativeCancellation) {
          assert.equal(
            result.cancelled,
            true,
            result.kind + " did not cancel remote preflight",
          );
          assert.equal(
            result.hasWindow,
            false,
            "cancelled preflight replaced the latest source",
          );
        }
        row.passed = true;
        await C.close();
        fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
        break;
      }
      await P.evaluate(() => {
        widget.timeSync().setValue(false);
        widget.dateRangeSync().setValue(false);
        widget.crosshairSync().setValue(true);
        widget.setLayout("4");
      });
      await P.waitForFunction(() => widget.chartsCount() === 4, null, {
        timeout: 10000,
      });
      for (let i = 0; i < 3; i++)
        await P.evaluate(
          async ({ i, r }) =>
            widget.chart(i + 1).setResolution(r, { doNotActivateChart: true }),
          { i, r: config.peers[i] },
        );
      await P.waitForFunction(
        () =>
          Array.from({ length: 4 }, (_, i) =>
            widget.chart(i).dataReady(),
          ).every(Boolean),
        null,
        { timeout: 15000 },
      );
      await P.waitForTimeout(100);
      const native =
        P.frames().find((f) => f.url().includes("charting_library")) ||
        P.frames()[1];
      assert.ok(native);
      const snapshot = () =>
        native.evaluate(() =>
          [...(globalThis.__navigationModels?.values() || [])]
            .filter((v) => v.canvas.isConnected)
            .map(({ m, canvas }) => {
              const c = m.crosshairSource(),
                ts = m.timeScale(),
                b = canvas.getBoundingClientRect();
              return {
                id: m.id(),
                res: m.interval(),
                time: ts.points().valueAt(c.appliedIndex()),
                center: ts
                  .points()
                  .valueAt(Math.round(ts.coordinateToIndex(ts.width() / 2))),
                x: c.x,
                visible: c.visible,
                label: { ...c._timeAxisView._rendererData },
                requesting: ts._requestingMoreData,
                box: { x: b.x, y: b.y, width: b.width, height: b.height },
              };
            }),
        );
      await P.evaluate(() => {
        stage = "click";
        widget.timeSync().setValue(true);
      });
      const boxes = await snapshot(),
        source = boxes.find((c) => c.res === config.source),
        root = await (await native.frameElement()).boundingBox(),
        x = root.x + source.box.x + source.box.width * config.ratio,
        y = root.y + source.box.y + source.box.height * 0.5;
      await P.mouse.move(x, y);
      await P.waitForTimeout(50);
      row.before = await snapshot();
      await P.mouse.down();
      await P.mouse.up();
      await P.waitForFunction(
        () =>
          !MWNativeNavigation.busy() &&
          Array.from({ length: widget.chartsCount() }, (_, i) =>
            widget.chart(i).dataReady(),
          ).every(Boolean),
        null,
        { timeout: 15000 },
      );
      await P.waitForTimeout(200);
      row.stationary = await snapshot();
      await P.mouse.move(x + Math.min(45, source.box.width * 0.07), y, {
        steps: 5,
      });
      await P.mouse.move(x, y, { steps: 5 });
      await P.waitForTimeout(120);
      row.afterMove = await snapshot();
      if (config.kind === "far" && config.peers.includes("5")) {
        await P.evaluate(() => widget.timeSync().setValue(false));
        const previous = await snapshot();
        if (process.env.NATIVE_NAVIGATION_LIFECYCLE) {
          await P.evaluate(() => {
            stage = "post-replacement-failure";
            injectFailure = "5";
          });
          const failed = await P.evaluate(async () => {
            try {
              await widget.chart(2).setVisibleRange({
                from: Date.UTC(2019, 0, 1) / 1000,
                to: Date.UTC(2019, 0, 1) / 1000 + 7200,
              });
              return false;
            } catch {
              return true;
            }
          });
          assert.ok(
            failed,
            "post-replacement source failure must reject navigation",
          );
          await P.waitForFunction(() => !MWNativeNavigation.busy());
          row.rollback = await snapshot();
          const old = previous.find((c) => c.res === "5"),
            restored = row.rollback.find((c) => c.res === "5");
          assert.equal(
            restored.center,
            old.center,
            "rollback moved a valid previous viewport",
          );
          await P.evaluate(async () => {
            const from = Date.UTC(2019, 0, 1) / 1000;
            await widget
              .chart(2)
              .setVisibleRange({ from, to: from + 17000 * 300 });
          });
          row.capacity17000 = await P.evaluate(() =>
            Math.max(
              ...trace
                .filter(
                  (r) =>
                    r.r === "5" &&
                    r.stage === "post-replacement-failure" &&
                    !r.error,
                )
                .map((r) => r.params.countBack),
            ),
          );
          await P.waitForTimeout(150);
          assert.ok(
            row.capacity17000 >= 17000 && row.capacity17000 <= 20000,
            "legal range demand was truncated or rejected",
          );
          await P.evaluate(() => (stage = "click"));
        }
        await P.evaluate(
          async (target) =>
            widget
              .chart(2)
              .setVisibleRange({ from: target - 3600, to: target + 3600 }),
          Date.UTC(2020, 1, 3) / 1000,
        );
        await P.waitForTimeout(150);
        row.publicRange = await snapshot();
        assert.ok(
          Math.abs(
            row.publicRange.find((c) => c.res === "5").center -
              Date.UTC(2020, 1, 3) / 1000,
          ) < 3600,
          "public visible range must navigate a bounded window",
        );
        for (const r of ["1", "15"])
          assert.equal(
            row.publicRange.find((c) => c.res === r).center,
            previous.find((c) => c.res === r).center,
            "rebuilding one window moved another pane",
          );
        const pane = row.publicRange.find((c) => c.res === "5"),
          left = root.x + pane.box.x,
          top = root.y + pane.box.y + pane.box.height * 0.5;
        await P.mouse.move(left + pane.box.width * 0.85, top);
        await P.mouse.down();
        await P.mouse.move(left + pane.box.width * 0.15, top, { steps: 20 });
        await P.waitForTimeout(250);
        row.heldNewer = await snapshot();
        await P.screenshot({ path: OUT.replace(".json", "-held-newer.png") });
        assert.ok(
          row.heldNewer.find((c) => c.res === "5").center > pane.center,
          "newer drag must move during mouse down",
        );
        await P.mouse.up();
        await P.waitForTimeout(200);
        await native.evaluate(() =>
          [...__navigationModels.values()]
            .find((v) => v.canvas.isConnected && v.m.interval() === "5")
            .m.resetTimeScale(),
        );
        await P.waitForTimeout(350);
        row.latest = await snapshot();
        assert.ok(
          row.latest.find((c) => c.res === "5").center >
            Date.UTC(2026, 8, 20) / 1000,
          "return to latest must use latest data",
        );
        await P.evaluate(() => {
          stage = "failure";
          injectFailure = "5";
        });
        await native.evaluate(async () => {
          const { m } = [...__navigationModels.values()].find(
            (v) => v.canvas.isConnected && v.m.interval() === "5",
          );
          m.timeScale().requestMoreHistoryPoints(1000);
        });
        await P.waitForTimeout(150);
        row.failed = await snapshot();
        assert.equal(
          row.failed.find((c) => c.res === "5").requesting,
          false,
          "failed request must release native loading",
        );
        await P.evaluate(() => (stage = "recovery"));
        await native.evaluate(async () => {
          const { m } = [...__navigationModels.values()].find(
            (v) => v.canvas.isConnected && v.m.interval() === "5",
          );
          const ts = m.timeScale(),
            p = ts.points().range().value(),
            target = ts.points().valueAt(p.firstIndex) - 18000;
          await m.gotoTime(target * 1000);
        });
        await P.waitForTimeout(150);
        row.recovered = await snapshot();
        assert.ok(
          Number.isFinite(row.recovered.find((c) => c.res === "5").center),
          "next navigation must recover after a history failure",
        );
      }
      row.requests = await P.evaluate(() => trace);
      row.rejected = row.requests.filter(
        (r) => r.error && !r.error.startsWith("injected"),
      );
      assert.deepEqual(
        row.rejected,
        [],
        "navigation must not request the entire history corridor",
      );
      for (const c of row.stationary) {
        const moved = row.afterMove.find((p) => p.id === c.id);
        assert.ok(
          Number.isFinite(c.center),
          "navigation must finish with actual bars in the viewport for " +
            c.res,
        );
        if (["1", "5", "15", "30", "60", "240"].includes(c.res))
          assert.equal(
            c.time,
            row.stationary.find((s) => s.res === config.source).time,
            "cursor must map to the original source time for " + c.res,
          );
        assert.equal(
          c.time,
          moved.time,
          "stationary cursor differs from the next mouse event for " + c.res,
        );
        assert.equal(
          c.requesting,
          false,
          "time axis stuck loading for " + c.res,
        );
        assert.ok(
          c.label.visible && c.label.text,
          "actual cursor label missing for " + c.res,
        );
      }
      assert.deepEqual(row.errors, []);
      await C.close();
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      console.log(
        JSON.stringify({
          config,
          rejected: row.rejected.map((r) => ({
            r: r.r,
            count: r.params.countBack,
          })),
          stationary: row.stationary.map((c) => ({
            r: c.res,
            time: c.time,
            center: c.center,
            requesting: c.requesting,
          })),
          after: row.afterMove.map((c) => ({
            r: c.res,
            time: c.time,
            center: c.center,
          })),
          errors: row.errors,
        }),
      );
    }
  } catch (e) {
    result.error = e.message;
    process.exitCode = 1;
    console.error(e.message);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    await B.close();
  }
})();
