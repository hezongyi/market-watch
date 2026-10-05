// Isolated full product sync acceptance. The licensed bundle is only observed.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.NATIVE_SYNC_APP || "https://localhost:15843",
  CHART = process.env.NATIVE_SYNC_CHART || "https://localhost:15844";
const OUT =
  process.env.NATIVE_SYNC_OUTPUT ||
  "/tmp/mw-chart-sync-acceptance/product.json";
const report = {
  at: new Date().toISOString(),
  scope:
    "actual provider OHLC, isolated PostgreSQL, native sync and pointer events",
  cases: [],
};
const save = () => fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const count of (process.env.COUNTS || "4").split(",").map(Number)) {
      const symbol = process.env.NATIVE_SYNC_SYMBOL || "EURUSD";
      const item = { count, symbol, errors: [], http: [], phases: [] };
      report.cases.push(item);
      save();
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1600, height: 1000 },
      });
      const response = await context.request.post(APP + "/api/login", {
        data: JSON.parse(
          fs.readFileSync(
            process.env.NATIVE_SYNC_LOGIN ||
              "/tmp/mw-chart-sync-acceptance/login.json",
          ),
        ),
      });
      assert.ok(response.ok());
      const csrf = (await response.json()).csrf;
      const api = async (endpoint, data) => {
        const r = await context.request.post(APP + "/api/" + endpoint, {
          headers: { "X-CSRF-Token": csrf },
          data,
        });
        assert.ok(r.ok(), endpoint + " " + r.status());
        return r.json();
      };
      const workspace = await api("advanced-charts/workspaces", {
        name: "Viewport sync acceptance " + count,
      });
      await api(`advanced-charts/workspaces/${workspace.id}/save`, {
        name: workspace.name,
        revision: workspace.revision,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          symbol: "MWP:" + symbol,
          series_kind: "provider",
          interval: "5",
        },
      });
      // Always reopen the workspace created by this case, even when another
      // isolated browser has recently saved its own workspace for this account.
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
            body: JSON.stringify(rows.filter((row) => row.id === workspace.id)),
          });
        },
      );
      const page = await context.newPage(),
        jobs = [];
      let phase = "initial",
        frame,
        native;
      let fault;
      await page.route("**/api/charts/data", async (route) => {
        const q = route.request().postDataJSON();
        if (fault && q.native_history?.historical_navigation) {
          const kind = fault;
          fault = null;
          if (kind === "delay") await new Promise((ok) => setTimeout(ok, 1500));
          else if (kind === "timeout") {
            await new Promise((ok) => setTimeout(ok, 31000));
            return route.abort().catch(() => {});
          } else
            return route.fulfill({
              status: kind === "busy" ? 409 : 503,
              contentType: "application/json",
              body: JSON.stringify({
                detail: {
                  code: "HISTORY_BUSY",
                  message: "isolated injected 503",
                },
              }),
            });
        }
        return route.continue();
      });
      page.on("pageerror", (e) =>
        item.errors.push({ phase, message: e.message, stack: e.stack }),
      );
      page.on("response", (r) => {
        if (!/\/api\/charts\/(data|reserve)$/.test(r.url())) return;
        const atPhase = phase;
        jobs.push(
          (async () => {
            let b;
            try {
              b = await r.json();
            } catch {
              return;
            }
            item.http.push({
              phase: atPhase,
              status: r.status(),
              query: r.request().postDataJSON(),
              count: b.bars?.length,
              mandatory: b.mandatory_count,
              reserve_status: b.reserve_status,
              attempts: b.candles_http_attempts,
            });
          })(),
        );
      });
      await page.route("**/bundles/library.*.js", async (route) => {
        const response = await route.fetch();
        let s = await response.text(),
          anchor = "s&&this._drawSources(e,t)}if(null!==this._state)";
        assert.equal(
          s.split(anchor).length,
          2,
          "native drawing probe must have one anchor",
        );
        const hook = `s&&(this._drawSources(e,t),(()=>{const m=this.state().model();if(!this.containsMainSeries())return;(globalThis.__syncModels??=new Map).set(m.id(),{m,canvas:e.canvas});if(!globalThis.__syncRecord)return;const ts=m.timeScale(),r=ts.visibleBarsStrictRange(),bars=m.mainSeries().bars(),w=Math.ceil(e.canvas.width/6),h=e.canvas.height;let pixels=0;const p=e.getImageData(0,30,w,h-60).data;for(let i=0;i<p.length;i+=16){const R=p[i],G=p[i+1],B=p[i+2];if((R>130&&R>G*1.45&&R>B*1.3)||(G>85&&G>R*1.5&&G>B*1.15))pixels++;}(globalThis.__syncFrames??=[]).push({id:m.id(),resolution:m.interval(),first:r?.firstBar(),firstAvailable:bars.firstIndex(),pixels});})())}if(null!==this._state)`;
        await route.fulfill({ response, body: s.replace(anchor, hook) });
      });
      async function settle() {
        await frame.waitForFunction(
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
        await page.waitForTimeout(500);
      }
      const snapshot = () =>
        frame.evaluate(() => ({
          active: widget.activeChartIndex(),
          sync: {
            crosshair: widget.crosshairSync().value(),
            time: widget.timeSync().value(),
            date: widget.dateRangeSync().value(),
          },
          reserve: MWNativeReserve.diagnostics(),
          charts: Array.from({ length: widget.chartsCount() }, (_, i) => {
            const c = widget.chart(i),
              ts = c.getTimeScale();
            return {
              priceMode: c
                .getPanes()[0]
                ?.getMainSourcePriceScale()
                ?.getMode?.(),
              symbol: c.symbol(),
              resolution: c.resolution(),
              range: c.getVisibleRange(),
              spacing: ts.barSpacing(),
              offset: ts.rightOffset(),
              width: ts.width(),
              studies: c.getAllStudies(),
              shapes: c.getAllShapes(),
              ready: c.dataReady(),
            };
          }),
        }));
      async function models() {
        return native.evaluate(() =>
          [...globalThis.__syncModels.values()]
            .filter((v) => v.canvas.isConnected)
            .map(({ m, canvas }) => {
              const b = canvas.getBoundingClientRect();
              return {
                id: m.id(),
                box: { x: b.x, y: b.y, width: b.width, height: b.height },
              };
            })
            .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x),
        );
      }
      async function box(index) {
        const mm = await models(),
          ib = await native.frameElement().then((e) => e.boundingBox());
        assert.equal(mm.length, count);
        const b = mm[index].box;
        return {
          x: b.x + ib.x,
          y: b.y + ib.y,
          width: b.width,
          height: b.height,
        };
      }
      async function crosshairs() {
        return native.evaluate(() =>
          [...globalThis.__syncModels.values()]
            .filter((v) => v.canvas.isConnected)
            .map(({ m, canvas }) => {
              const c = m.crosshairSource(),
                ts = m.timeScale(),
                i = c.appliedIndex(),
                b = canvas.getBoundingClientRect();
              return {
                id: m.id(),
                resolution: m.interval(),
                time: ts.points().valueAt(i),
                index: i,
                price: c.price,
                x: c.x,
                y: c.y,
                pane: !!c.pane,
                visible: c.visible,
                label: { ...c._timeAxisView._rendererData },
                centerTime: ts
                  .points()
                  .valueAt(Math.round(ts.coordinateToIndex(ts.width() / 2))),
                box: { x: b.x, y: b.y },
              };
            })
            .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x),
        );
      }
      try {
        await page.addInitScript(() => {
          globalThis.__productNotices = [];
          addEventListener("message", (e) => {
            if (e.data?.type === "error") __productNotices.push(e.data.error);
          });
        });
        await page.goto(APP + "/advanced-charts");
        await page.waitForFunction(
          (chart) =>
            [...document.querySelectorAll("iframe")].some((f) =>
              f.src.startsWith(chart + "/"),
            ),
          CHART,
        );
        for (let n = 0; n < 300 && !frame; n++) {
          frame = page.frames().find((f) => f.url().startsWith(CHART + "/"));
          if (!frame) await page.waitForTimeout(100);
        }
        assert.ok(frame);
        await settle();
        await frame.evaluate((count) => {
          widget.timeSync().setValue(false);
          widget.dateRangeSync().setValue(false);
          widget.crosshairSync().setValue(true);
          widget.setLayout(count === 2 ? "2h" : String(count));
        }, count);
        await settle();
        await frame.evaluate(async () => {
          for (let i = 0; i < widget.chartsCount(); i++)
            await widget
              .chart(i)
              .setResolution(i === 0 ? "1W" : ["5", "240", "1D"][(i - 1) % 3], {
                doNotActivateChart: true,
              });
        });
        await settle();
        native =
          frame
            .childFrames()
            .find((f) => f.url().includes("charting_library")) ||
          frame.childFrames()[0];
        assert.ok(native);
        item.initial = await snapshot();
        assert.ok(
          item.initial.charts.every(
            (chart) => chart.symbol === "MWP:" + symbol,
          ),
        );
        await frame.evaluate(() => widget.timeSync().setValue(true));
        const b = await box(0),
          sourceX = await native.evaluate(() => {
            const { m } = [...__syncModels.values()].find(
              (v) => v.canvas.isConnected && v.m.interval() === "1W",
            );
            const ts = m.timeScale(),
              p = ts.points().range().value();
            return ts.indexToCoordinate(
              Math.max(
                p.firstIndex,
                p.lastIndex - Math.ceil((ts.width() / ts.barSpacing()) * 0.5),
              ),
            );
          }),
          x = b.x + sourceX,
          y = b.y + b.height * 0.45;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.up();
        await frame.waitForFunction(
          () =>
            MWNativeNavigation.diagnostics().pending === 0 &&
            MWNativeReserve.diagnostics().threads.every((t) => !t.requesting),
          null,
          { timeout: 45000 },
        );
        await settle();
        await page.waitForTimeout(250);
        item.stationary = await crosshairs();
        await page.screenshot({
          path: OUT.replace(".json", `-${count}-stationary.png`),
        });
        await page.mouse.move(x + 20, y);
        await page.mouse.move(x, y);
        await page.waitForTimeout(200);
        item.afterMove = await crosshairs();
        for (let i = 0; i < count; i++)
          assert.equal(
            item.stationary[i].time,
            item.afterMove[i].time,
            "stationary cursor changed on next mouse move " + i,
          );
        assert.ok(
          item.stationary.every(
            (c) => Number.isFinite(c.centerTime) && c.visible && c.label.text,
          ),
          "actual bars/cursor labels must render",
        );
        const target = item.stationary[0].time;
        assert.ok(
          item.stationary
            .filter((c) => c.resolution === "5")
            .every((c) => c.time === target),
          "M5 must align to weekly source time",
        );
        item.final = await snapshot();
        assert.ok(
          item.http
            .filter((r) => r.query?.timeframe === "M5")
            .every((r) => r.query.limit <= 20000),
          "unbounded native demand escaped",
        );
        assert.ok(
          item.http.some((r) => r.query?.native_history?.historical_navigation),
          "bounded navigation did not use the product transport",
        );
        await frame.evaluate(() => widget.timeSync().setValue(false));
        await frame.evaluate(() =>
          widget.chart(0).setResolution("5", { doNotActivateChart: true }),
        );
        await settle();
        const before = await snapshot();
        await frame.evaluate(
          async (target) => {
            for (let n = 0; ; n++) {
              try {
                await widget
                  .chart(1)
                  .setVisibleRange({ from: target - 3600, to: target + 3600 });
                break;
              } catch (e) {
                if (e.message !== "Value is null" || n > 20) throw e;
                await new Promise((ok) => setTimeout(ok, 100));
              }
            }
          },
          target - 364 * 86400,
        );
        await settle();
        item.samePeriod = await snapshot();
        assert.deepEqual(
          item.samePeriod.charts[0].range,
          before.charts[0].range,
          "same-period historical window cleared latest peer",
        );
        assert.ok(
          item.samePeriod.charts[1].range.to <
            item.samePeriod.charts[0].range.from,
          "disjoint same-period windows missing",
        );
        fault = "503";
        phase = "injected-503";
        const failed = await frame.evaluate(
          async (target) => {
            try {
              await widget
                .chart(1)
                .setVisibleRange({ from: target - 3600, to: target + 3600 });
              return false;
            } catch (e) {
              return true;
            }
          },
          target - 728 * 86400,
        );
        assert.ok(failed, "503 must fail the navigation");
        item.afterFailure = await snapshot();
        assert.deepEqual(
          item.afterFailure.charts[1].range,
          item.samePeriod.charts[1].range,
          "failed candidate must keep valid viewport",
        );
        if (count === 4) {
          phase = "date-navigation";
          await native.evaluate(
            (target) => {
              const m = [...__syncModels.values()].find(
                (v) =>
                  v.canvas.isConnected &&
                  v.m.interval() === "5" &&
                  v.m.timeScale().rightOffset() < 0,
              ).m;
              m.mainSeries().loadDataTo({
                type: "time-range",
                from: target - 3600,
                to: target + 3600,
              });
            },
            target - 500 * 86400,
          );
          await settle();
          item.dateNavigation = await snapshot();
          assert.ok(
            Math.abs(
              item.dateNavigation.charts[1].range.from -
                (target - 500 * 86400 - 3600),
            ) < 900,
            "native date navigation failed to restore target range",
          );
          if (process.env.NATIVE_SYNC_DIALOG) {
            const positions = await crosshairs();
            const b = await box(
              positions.findIndex(
                (c) =>
                  c.resolution === "5" && c.centerTime < target - 300 * 86400,
              ),
            );
            await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.45);
            await page.keyboard.press("Alt+g");
            const input = native.getByPlaceholder("YYYY-MM-DD");
            await input.waitFor();
            const date = new Date((target - 600 * 86400) * 1000)
              .toISOString()
              .slice(0, 10);
            await input.fill(date);
            await native.locator("button[name=submit]").click();
            await frame.waitForFunction(
              (timestamp) => {
                const range = widget.chart(1).getVisibleRange();
                return range.from <= timestamp + 86400 && range.to >= timestamp;
              },
              Date.parse(date) / 1000,
              { timeout: 45000 },
            );
            await settle();
            item.nativeDialog = {
              date,
              actual: (await snapshot()).charts[1].range,
            };
            const timestamp = Date.parse(date) / 1000;
            assert.ok(
              item.nativeDialog.actual.from <= timestamp + 86400 &&
                item.nativeDialog.actual.to >= timestamp,
              "native date dialog did not navigate to requested trading date",
            );
          }
        }
        phase = "retry";
        await frame.evaluate(
          async (target) =>
            widget
              .chart(1)
              .setVisibleRange({ from: target - 3600, to: target + 3600 }),
          target - 728 * 86400,
        );
        await settle();
        item.retried = await snapshot();
        if (process.env.NATIVE_SYNC_ERRORS && count === 2) {
          item.errorRecovery = [];
          for (const kind of ["busy", "timeout"]) {
            fault = kind;
            phase = "injected-" + kind;
            const beforeError = await snapshot();
            const code = await frame.evaluate(
              async (target) => {
                try {
                  await widget.chart(1).setVisibleRange({
                    from: target - 3600,
                    to: target + 3600,
                  });
                  return "NO_ERROR";
                } catch (error) {
                  return error.code;
                }
              },
              target - 1400 * 86400,
            );
            assert.equal(
              code,
              kind === "busy" ? "HISTORY_BUSY" : "HISTORY_TIMEOUT",
            );
            await settle();
            const afterError = await snapshot();
            assert.deepEqual(
              afterError.charts[1].range,
              beforeError.charts[1].range,
            );
            await frame.evaluate(
              async (target) =>
                widget
                  .chart(1)
                  .setVisibleRange({ from: target - 3600, to: target + 3600 }),
              target - 728 * 86400,
            );
            await settle();
            item.errorRecovery.push({
              kind,
              code,
              retainedRange: afterError.charts[1].range,
              recovered: true,
            });
          }
        }
        fault = "delay";
        phase = "cached-cancellation";
        item.cachedCancelled = await frame.evaluate(
          async (target) => {
            const cached = widget.chart(1).getVisibleRange();
            const remote = widget
              .chart(1)
              .setVisibleRange({ from: target - 3600, to: target + 3600 })
              .then(
                () => false,
                (e) => e.code === "HISTORY_CANCELLED",
              );
            await new Promise((resolve) => setTimeout(resolve, 150));
            await widget.chart(1).setVisibleRange(cached);
            return remote;
          },
          target - 1092 * 86400,
        );
        assert.ok(
          item.cachedCancelled,
          "cached navigation failed to supersede delayed remote candidate",
        );
        await settle();
        fault = "delay";
        phase = "cancellation";
        item.cancelled = await frame.evaluate(
          async (target) => {
            const first = widget
              .chart(1)
              .setVisibleRange({
                from: target - 364 * 86400 - 3600,
                to: target - 364 * 86400 + 3600,
              })
              .then(
                () => false,
                (e) => e.code === "HISTORY_CANCELLED",
              );
            await new Promise((ok) => setTimeout(ok, 150));
            await widget
              .chart(1)
              .setVisibleRange({ from: target - 3600, to: target + 3600 });
            return first;
          },
          target - 1092 * 86400,
        );
        assert.ok(
          item.cancelled,
          "superseded navigation must not apply old range",
        );
        await settle();
        item.samePeriod = await snapshot();
        await frame.evaluate(async () => {
          await widget
            .chart(1)
            .createStudy("Moving Average", false, false, { length: 200 });
        });
        await settle();
        if (count === 4) {
          await frame.evaluate(() =>
            widget
              .chart(1)
              .createStudy("守望 Python SMA", false, false, { period: 200 }),
          );
          await settle();
          await frame.waitForFunction(
            () =>
              [...subscriptions.values()].some(
                (sub) => decode(sub.symbol).spec,
              ),
            null,
            { timeout: 20000 },
          );
          await Promise.all(jobs);
          assert.ok(
            item.http.some((row) => row.query?.indicators?.length),
            "Python indicator did not use provider transport",
          );
        }
        if (count === 4)
          await frame.evaluate(() =>
            widget.chart(1).getPanes()[0].getMainSourcePriceScale().setMode(1),
          );
        const positions = await crosshairs(),
          historicalIndex = positions.findIndex(
            (c) => c.resolution === "5" && c.centerTime < target - 300 * 86400,
          );
        assert.ok(historicalIndex >= 0);
        const held = await box(historicalIndex);
        await page.mouse.move(
          held.x + held.width * 0.8,
          held.y + held.height * 0.45,
        );
        await page.mouse.down();
        await page.mouse.move(
          held.x + held.width * 0.2,
          held.y + held.height * 0.45,
          { steps: 20 },
        );
        await page.waitForTimeout(300);
        item.held = await snapshot();
        await page.screenshot({
          path: OUT.replace(".json", `-${count}-held.png`),
        });
        assert.ok(
          item.held.charts[1].range.to > item.samePeriod.charts[1].range.to,
          "newer drag did not render during mouse down",
        );
        await page.mouse.up();
        await settle();
        if (count === 4) {
          phase = "continuous-newer-boundary";
          await frame.evaluate(() =>
            widget
              .chart(1)
              .createShape(
                { time: widget.chart(1).getVisibleRange().from, price: 1.1 },
                { shape: "horizontal_line" },
              ),
          );
          await settle();
          item.beforeBoundaries = await snapshot();
          item.boundaries = [];
          const windowIds = new Set();
          for (let step = 0; step < 10; step++) {
            const b = await box(historicalIndex),
              previous = await snapshot();
            const windowBefore = await frame.evaluate(
              () => MWNativeNavigation.chartWindow(widget.chart(1))?.id,
            );
            windowIds.add(windowBefore);
            // A delayed candidate must preserve movement made while it waits.
            if (step === 3) fault = "delay";
            await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.45);
            await page.mouse.down();
            await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.45, {
              steps: 15,
            });
            await page.waitForTimeout(150);
            const intermediate = await snapshot();
            await page.mouse.move(b.x + b.width * 0.15, b.y + b.height * 0.45, {
              steps: 15,
            });
            await settle();
            const held = await snapshot();
            item.boundaries.push({
              windowBefore,
              range: held.charts[1].range,
              intermediate: intermediate.charts[1].range,
            });
            item.boundaryDiagnostics = await native.evaluate(() =>
              [...__syncModels.values()]
                .filter((v) => v.canvas.isConnected)
                .map(({ m }) => ({
                  r: m.interval(),
                  points: m.timeScale().points().range().value(),
                  range: m.timeScale().visibleBarsStrictRange(),
                  bars: [
                    m.mainSeries().bars().firstIndex(),
                    m.mainSeries().bars().lastIndex(),
                  ],
                })),
            );
            assert.ok(
              held.charts[1].range.from >= intermediate.charts[1].range.from,
              "candidate replacement snapped back the continued held drag",
            );
            assert.ok(
              held.charts[1].range.to > previous.charts[1].range.to,
              "newer boundary stopped advancing while held",
            );
            assert.equal(
              held.charts[1].spacing,
              item.beforeBoundaries.charts[1].spacing,
            );
            assert.equal(
              held.charts[1].priceMode,
              item.beforeBoundaries.charts[1].priceMode,
            );
            assert.deepEqual(
              held.charts[1].shapes,
              item.beforeBoundaries.charts[1].shapes,
            );

            if (step === 9)
              await page.screenshot({
                path: OUT.replace(".json", `-${count}-boundary-held.png`),
              });
            await page.mouse.up();
            await settle();
          }
          assert.ok(
            windowIds.size >= 3,
            "held drags did not cross multiple native windows",
          );
          const nav = await frame.evaluate(() =>
            MWNativeNavigation.diagnostics(),
          );
          assert.ok(
            nav.windows.length <= count,
            "old windows accumulated after repeated navigation",
          );
          phase = "history-correction";
          const beforeReset = await snapshot();
          const event = await frame.evaluate(() => {
            const id = MWNativeNavigation.chartWindow(widget.chart(1)).id;
            const sub = [...subscriptions.values()].find(
              (s) => s.window === id && s.res === "5",
            );
            const state = providerHistoryState.get(sub.symbol + "|" + sub.res);
            return {
              listener: sub.providerListener,
              type: "reset",
              revision: state.revision,
              as_of: state.observed_at,
              cursor: sub.last,
            };
          });
          await page.evaluate(
            ({ event, chart }) =>
              document
                .querySelector("iframe")
                .contentWindow.postMessage(
                  { channel: "mw-chart-v1", type: "provider-event", event },
                  chart,
                ),
            { event, chart: CHART },
          );
          await page.waitForTimeout(200);
          await settle();
          await frame.waitForFunction(() => !historyReloading, null, {
            timeout: 30000,
          });
          item.corrected = await snapshot();
          assert.deepEqual(
            item.corrected.charts[0].range,
            beforeReset.charts[0].range,
            "history reset disturbed latest peer",
          );
          assert.deepEqual(
            item.corrected.charts[1].range,
            beforeReset.charts[1].range,
            "history reset lost its own viewport",
          );
          assert.deepEqual(
            item.corrected.charts[1].shapes,
            beforeReset.charts[1].shapes,
          );
        }
        await settle();
        item.saved = await snapshot();
        await frame.evaluate(
          () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
        );
        await page.waitForTimeout(250);
        await page.reload();
        frame = undefined;
        for (let n = 0; n < 300 && !frame; n++) {
          frame = page.frames().find((f) => f.url().startsWith(CHART + "/"));
          if (!frame) await page.waitForTimeout(100);
        }
        assert.ok(frame);
        await settle();
        native =
          frame
            .childFrames()
            .find((f) => f.url().includes("charting_library")) ||
          frame.childFrames()[0];
        item.restored = await snapshot();
        for (let i = 0; i < count; i++) {
          assert.deepEqual(
            item.restored.charts[i].studies,
            item.saved.charts[i].studies,
          );
          for (const edge of ["from", "to"])
            assert.ok(
              Math.abs(
                item.restored.charts[i].range[edge] -
                  item.saved.charts[i].range[edge],
              ) < 900,
              "reload lost historical viewport " + i,
            );
        }
        item.navigation = await frame.evaluate(() =>
          MWNativeNavigation.diagnostics(),
        );
        await Promise.all(jobs);
        assert.deepEqual(item.errors, []);
        assert.ok(
          item.http.every(
            (r) =>
              r.status === 200 ||
              (r.phase === "injected-503" && r.status === 503) ||
              (r.phase === "injected-busy" && r.status === 409),
          ),
          "history HTTP failure",
        );
        item.passed = true;
      } catch (e) {
        item.error = String(e);
        item.notices = await page
          .evaluate(() => __productNotices)
          .catch(() => []);
        item.navigation = await frame
          ?.evaluate(() => MWNativeNavigation.diagnostics())
          .catch(() => null);
        item.observed = await (
          frame ? snapshot() : Promise.resolve(null)
        ).catch(() => null);
        await page
          .screenshot({ path: OUT.replace(".json", `-${count}-failure.png`) })
          .catch(() => {});
      } finally {
        await Promise.allSettled(jobs);
        save();
        await context.close();
      }
    }
  } finally {
    save();
    await browser.close();
  }
  assert.ok(
    report.cases.every((c) => c.passed),
    "native sync acceptance failed",
  );
})().catch((e) => {
  report.error = String(e);
  save();
  console.error(e.message);
  process.exitCode = 1;
});
