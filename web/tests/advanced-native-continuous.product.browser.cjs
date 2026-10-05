// Isolated full product sync acceptance. The licensed bundle is only observed.
const { execFileSync } = require("node:child_process");
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.NATIVE_SYNC_APP || "https://192.168.7.232:16343",
  CHART = process.env.NATIVE_SYNC_CHART || "https://192.168.7.232:16344";
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
      await page.route("**/api/charts/history-loads", async (route) => {
        const q = route.request().postDataJSON().query;
        if (fault && q.native_history) {
          const kind = fault;
          fault = null;
          if (kind === "delay") await new Promise((ok) => setTimeout(ok, 5000));
          else
            return route.fulfill({
              status:
                kind === "busy"
                  ? 409
                  : kind === "timeout"
                    ? 408
                    : kind === "capacity"
                      ? 400
                      : 503,
              contentType: "application/json",
              body: JSON.stringify({
                detail: {
                  code:
                    kind === "timeout"
                      ? "HISTORY_TIMEOUT"
                      : kind === "capacity"
                        ? "NATIVE_HISTORY_CAPACITY_EXCEEDED"
                        : kind === "failure"
                          ? "HISTORY_PROVIDER_FAILED"
                          : "HISTORY_BUSY",
                  message: "isolated injected " + kind,
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
        if (
          !/\/api\/charts\/(history-loads(?:\/[^/]+(?:\/result)?)?|reserve)$/.test(
            r.url(),
          )
        )
          return;
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
              url: r.url(),
              query:
                r.request().method() === "POST"
                  ? r.request().postDataJSON()?.query ||
                    r.request().postDataJSON()
                  : undefined,
              count: (b.result || b).bars?.length,
              load: b.load || (b.state ? b : undefined),
              mandatory: (b.result || b).mandatory_count,
              cache_hit: (b.result || b).cache_hit,
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
            !historyReloading &&
            !rangeGuard.busy() &&
            !edgeGuard.busy() &&
            !MWNativeNavigation.busy() &&
            Array.from({ length: widget.chartsCount() }, (_, i) =>
              widget.chart(i).dataReady(),
            ).every(Boolean),
          null,
          { timeout: 120000 },
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
      async function box(index, publicChart = false) {
        const mm = await models(),
          ib = await native.frameElement().then((e) => e.boundingBox());
        assert.equal(mm.length, count);
        const id = publicChart
          ? await frame.evaluate(
              (index) => widget.chart(index)._chartWidget.model().model().id(),
              index,
            )
          : null;
        const b = (publicChart ? mm.find((m) => m.id === id) : mm[index]).box;
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
          globalThis.__historyPerf = { longTasks: [], maxFrameGap: 0 };
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              __historyPerf.longTasks.push({
                start: entry.startTime,
                duration: entry.duration,
              });
          }).observe({ type: "longtask", buffered: true });
          let previous;
          const tick = (at) => {
            if (previous)
              __historyPerf.maxFrameGap = Math.max(
                __historyPerf.maxFrameGap,
                at - previous,
              );
            previous = at;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
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
        if (process.env.CONTINUOUS_FULL === "1" &&
          await frame.evaluate(() => MWNativeNavigation.diagnostics().limits.max_bars !== 200000)) {
          await native.getByRole("button", {name:"图表菜单",exact:true}).click();
          await native.getByRole("button", {name:"历史数据容量",exact:true}).click();
          const initialCapacity = page.locator(".history-capacity-dialog");
          await initialCapacity.waitFor();
          await initialCapacity.getByLabel("单源容量（根）").fill("200000");
          await initialCapacity.getByRole("button", {name:"保存",exact:true}).click();
          await initialCapacity.waitFor({state:"hidden"});
          await frame.waitForFunction(() => MWNativeNavigation.diagnostics().limits.max_bars === 200000);
        }
        item.initial = await snapshot();
        if (process.env.NATIVE_BOUNDARY_ONLY === "1") {
          phase = "capacity-boundary";
          await require("./native-capacity-boundary.cjs")({
            page,
            frame,
            native,
            settle,
            box,
            snapshot,
            item,
            save,
          });
          assert.deepEqual(item.errors, []);
          item.passed = true;
          save();
          continue;
        }
        if (process.env.NATIVE_CAPACITY_NOTICE_ONLY === "1") {
          phase = "capacity-notice";
          await require("./native-capacity-notice.cjs")({
            page,
            frame,
            native,
            settle,
            box,
            snapshot,
            item,
            save,
          });
          assert.deepEqual(item.errors, []);
          item.passed = true;
          save();
          continue;
        }
        if (process.env.NATIVE_INTERACTIONS_FAST === "1") {
          phase = "interactions";
          await require("./native-continuous-interactions.cjs")({
            page,
            frame,
            native,
            settle,
            box,
            snapshot,
            crosshairs,
            item,
            save,
          });
          assert.deepEqual(item.errors, []);
          item.passed = true;
          save();
          continue;
        }
        if (process.env.NATIVE_TEMPLATE_UNDO === "1") {
          item.undoTemplate = await frame.evaluate(async () => {
            const c = widget.chart(1),
              empty = c.createStudyTemplate({
                saveSymbol: false,
                saveInterval: false,
              });
            for (let i = 0; i < 10; i++)
              await c.createStudy("Moving Average", false, false, {
                length: 21 + i,
              });
            const full = c.createStudyTemplate({
              saveSymbol: false,
              saveInterval: false,
            });
            c.applyStudyTemplate(full);
            globalThis.__emptyUndoTemplate = empty;
            return { prepared: true, range: c.getVisibleRange() };
          });
          await settle();
          await frame.evaluate(() =>
            widget.chart(1).applyStudyTemplate(__emptyUndoTemplate),
          );
          await settle();
          item.undoTemplate.beforeUndo = await frame.evaluate(() =>
            widget.undoRedoState(),
          );
          save();
          await frame.evaluate(() => {
            widget.setActiveChart(1);
            widget.undo();
          });
          await frame.waitForFunction(
            () => widget.chart(1).getAllStudies().length === 10,
          );
          await settle();
          item.undoTemplate.undoStudies = await frame.evaluate(
            () => widget.chart(1).getAllStudies().length,
          );
          await frame.evaluate(() => widget.redo());
          await frame.waitForFunction(
            () => widget.chart(1).getAllStudies().length === 0,
          );
          await settle();
          item.undoTemplate.redoStudies = await frame.evaluate(
            () => widget.chart(1).getAllStudies().length,
          );
          assert.equal(
            item.undoTemplate.undoStudies,
            10,
            "under-budget undo restores the full template",
          );
          assert.equal(
            item.undoTemplate.redoStudies,
            0,
            "under-budget redo reapplies the empty template",
          );
          await settle();
        }
        assert.ok(
          item.initial.charts.every(
            (chart) => chart.symbol === "MWP:" + symbol,
          ),
        );
        await frame.evaluate(async () => {
          await widget.chart(0).setVisibleRange({
            from: Date.parse("2025-10-01") / 1000,
            to: Date.parse("2026-02-01") / 1000,
          });
          widget.timeSync().setValue(true);
        });
        const b = await box(0),
          sourceX = await native.evaluate(() => {
            const { m } = [...__syncModels.values()].find(
              (v) => v.canvas.isConnected && v.m.interval() === "1W",
            );
            const ts = m.timeScale(),
              p = ts.points().range().value();
            return ts.width() * 0.5;
          }),
          x = b.x + sourceX,
          y = b.y + b.height * 0.45;
        await page.mouse.move(x, y);
        const navigationStarted = Date.now();
        await page.mouse.down();
        await page.mouse.up();
        await frame.waitForFunction(
          () =>
            MWNativeNavigation.diagnostics().pending === 0 &&
            MWNativeReserve.diagnostics().threads.every((t) => !t.requesting),
          null,
          { timeout: 900000 },
        );
        await settle();
        item.clickToReadyMs = Date.now() - navigationStarted;
        await page.waitForTimeout(250);
        item.semanticBefore = await frame.evaluate(() =>
          MWNativeNavigation.diagnostics(),
        );
        item.stationary = await crosshairs();
        await page.screenshot({
          path: OUT.replace(".json", `-${count}-stationary.png`),
        });
        await page.mouse.move(x + 20, y);
        await page.mouse.move(x, y);
        await page.waitForTimeout(200);
        await page.waitForTimeout(1000);
        item.afterMove = await crosshairs();
        item.semanticAfter = await frame.evaluate(() =>
          MWNativeNavigation.diagnostics(),
        );
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
          item.http.some(
            (r) => r.query?.timeframe === "M5" && r.query.limit > 20000,
          ),
          "original large native demand must reach product transport",
        );
        assert.equal(
          (await frame.evaluate(() => MWNativeNavigation.diagnostics())).windows
            .length,
          0,
        );
        item.navigation = await frame.evaluate(() =>
          MWNativeNavigation.diagnostics(),
        );
        const beforeHover = item.http.length;
        await page.waitForTimeout(15000);
        for (let move = 1; move <= 5; move++) {
          await page.mouse.move(x + move * 7, y);
          await page.waitForTimeout(400);
        }
        await page.waitForTimeout(10000);
        item.afterHover = await snapshot();
        item.performance = await native.evaluate(() => ({
          ...__historyPerf,
          heap: performance.memory?.usedJSHeapSize,
        }));
        item.hoverRequests = item.http.slice(beforeHover);
        assert.ok(
          item.hoverRequests.every(
            (r) => !r.query?.countBack || r.query.countBack < 20000,
          ),
          "hover must not reload historical corridor",
        );
        await page.screenshot({ path: OUT.replace(".json", "-hover.png") });
        phase = "same-widget-cache";
        const cachedChart = item.final.charts.findIndex(
          (c) => c.resolution === "5",
        );
        if (cachedChart >= 0) {
          const target = await frame.evaluate((index) => {
            const ts = widget
              .chart(index)
              ._chartWidget.model()
              .model()
              .timeScale();
            const range = ts.visibleBarsStrictRange();
            return ts
              .points()
              .valueAt(Math.floor((range.firstBar() + range.lastBar()) / 2));
          }, cachedChart);
          const at = Date.now();
          await frame.evaluate(
            ({ cachedChart, target }) =>
              widget
                .chart(cachedChart)
                .setVisibleRange(
                  { from: target - 1800, to: target + 1800 },
                  { rejectByTimeout: 120000 },
                ),
            { cachedChart, target },
          );
          const rangeReadyMs = Date.now() - at;
          await settle();
          await Promise.all(jobs);
          const after = await snapshot();
          assert.ok(
            after.charts[cachedChart].range.from <= target &&
              after.charts[cachedChart].range.to >= target,
          );
          const reads = item.http.filter(
            (r) =>
              r.phase === phase &&
              r.query?.native_history &&
              !r.query?.native_reserve,
          );
          assert.equal(
            reads.length,
            0,
            "already loaded native corridor must locate without backend history reads",
          );
          item.sameWidgetCache = {
            rangeReadyMs,
            settledMs: Date.now() - at,
            range: after.charts[cachedChart].range,
            historyReads: reads.length,
          };
          save();
        }
        if (process.env.NATIVE_INTERACTIONS === "1") {
          phase = "interactions";
          await require("./native-continuous-interactions.cjs")({
            page,
            frame,
            native,
            settle,
            box,
            snapshot,
            crosshairs,
            item,
            save,
          });
          assert.deepEqual(
            item.errors,
            [],
            "native interaction operations must not raise JS errors",
          );
        }
        if (process.env.NATIVE_LIFECYCLE === "1") {
          phase = "lifecycle";
          await require("./native-continuous-lifecycle.cjs")({
            browser,
            context,
            page,
            frame,
            native,
            settle,
            save,
            item,
          });
          assert.deepEqual(
            item.errors,
            [],
            "lifecycle operations must not raise JS errors",
          );
        }
        if (process.env.NATIVE_TEMPLATE_UNDO === "1") {
          item.undoTemplate.result = await frame.evaluate(() => {
            const c = widget.chart(1);
            widget.setActiveChart(1);
            const errors = [];
            const record = (e) =>
              errors.push({ code: e.detail.code, message: e.detail.message });
            addEventListener("mw-navigation-error", record);
            let error;
            const attempts = [];
            try {
              for (let i = 0; i < 20 && !errors.length; i++) {
                const before = widget.undoRedoState();
                try {
                  widget.undo();
                } catch (e) {
                  error = { code: e.code, message: e.message };
                }
                attempts.push({ before, after: widget.undoRedoState() });
                if (error) break;
              }
            } finally {
              removeEventListener("mw-navigation-error", record);
            }
            return {
              error,
              errors,
              attempts,
              studies: c.getAllStudies(),
              range: c.getVisibleRange(),
            };
          });
          save();
          assert.ok(
            item.undoTemplate.result.errors.some(
              (e) => e.code === "NATIVE_HISTORY_CAPACITY_EXCEEDED",
            ),
            "undo after historical growth must recheck template capacity",
          );
          assert.equal(
            item.undoTemplate.result.studies.length,
            0,
            "refused undo keeps the lightweight template",
          );
          const refused = item.undoTemplate.result.attempts.at(-1);
          assert.deepEqual(
            refused.after,
            refused.before,
            "budget refusal preserves undo and redo stacks",
          );
          await settle();
          item.undoTemplate.recovered = await frame.evaluate(async () => {
            const c = widget.chart(1),
              id = await c.createStudy("Moving Average", false, false, {
                length: 21,
              });
            c.removeEntity(id);
            return true;
          });
          await settle();
        }
        if (process.env.CONTINUOUS_FULL === "1") {
          await frame.evaluate(() => widget.timeSync().setValue(false));
          const m5 = item.final.charts.findIndex((c) => c.resolution === "5");
          const target = Date.parse("2025-12-01") / 1000;
          item.faultRecovery = [];
          for (const kind of ["busy", "failure", "timeout", "capacity"]) {
            phase = "recover-" + kind;
            fault = kind;
            await frame.evaluate(
              ({ m5, target }) =>
                widget
                  .chart(m5)
                  .setVisibleRange(
                    {
                      from: target - 30 * 86400,
                      to: target - 30 * 86400 + 3600,
                    },
                    { rejectByTimeout: 30000 },
                  )
                  .catch(() => {}),
              { m5, target },
            );
            await settle();
            await frame.evaluate(
              ({ m5, target }) =>
                widget
                  .chart(m5)
                  .setVisibleRange({ from: target - 1800, to: target + 1800 }),
              { m5, target },
            );
            await settle();
            const state = await snapshot();
            assert.ok(
              state.charts[m5].range.from <= target &&
                state.charts[m5].range.to >= target,
              "fault must allow next navigation",
            );
            assert.equal(
              fault,
              null,
              "fault must actually reach the product HTTP path",
            );
            item.faultRecovery.push({
              kind,
              injectedCode: {
                busy: "HISTORY_BUSY",
                failure: "HISTORY_PROVIDER_FAILED",
                timeout: "HISTORY_TIMEOUT",
                capacity: "NATIVE_HISTORY_CAPACITY_EXCEEDED",
              }[kind],
              injection: "isolated HTTP error response",
              recovered: true,
              range: state.charts[m5].range,
            });
            save();
          }
          // Capacity fallback now fills available residency. Cancellation must
          // target genuinely uncached history with room for a new request.
          const capacityDialog = page.locator(".history-capacity-dialog");
          const changeCapacity = async (value) => {
            await native.getByRole("button", {name:"图表菜单",exact:true}).click();
            await native.getByRole("button", {name:"历史数据容量",exact:true}).click();
            await capacityDialog.waitFor();
            await capacityDialog.getByLabel("单源容量（根）").fill(String(value));
            await capacityDialog.getByRole("button", {name:"保存",exact:true}).click();
            await capacityDialog.waitFor({state:"hidden"});
            await frame.waitForFunction(n => MWNativeNavigation.diagnostics().limits.max_bars === n, value);
          };
          await changeCapacity(400000);
          const cancelTarget = await frame.evaluate((m5) => {
            const ts = widget.chart(m5)._chartWidget.model().model().timeScale();
            return ts.points().valueAt(ts.points().range().value().firstIndex) - 14 * 86400;
          },m5);
          phase = "cancel";
          fault = "delay";
          await frame.evaluate(
            ({ m5, cancelTarget }) => {
              globalThis.__oldRange = widget
                .chart(m5)
                .setVisibleRange(
                  { from: cancelTarget, to: cancelTarget + 3600 },
                  { rejectByTimeout: 30000 },
                )
                .then(
                  () => "completed",
                  () => "cancelled",
                );
            },
            { m5, cancelTarget },
          );
          await frame.waitForFunction(
            () => MWNativeNavigation.diagnostics().pending > 0,
          );
          item.cancelOutcome = await frame.evaluate(
            async ({ m5, target }) => {
              await widget
                .chart(m5)
                .setVisibleRange({ from: target - 1800, to: target + 1800 });
              return __oldRange;
            },
            { m5, target },
          );
          assert.equal(
            item.cancelOutcome,
            "cancelled",
            "superseded loading public range must reject",
          );
          await settle();
          item.cancelledView = await snapshot();
          assert.ok(
            item.cancelledView.charts[m5].range.from <= target &&
              item.cancelledView.charts[m5].range.to >= target,
          );
          phase = "return-latest";
          fault = "delay";
          await frame.evaluate(
            ({ m5, cancelTarget }) => {
              globalThis.__oldToLatest = widget
                .chart(m5)
                .setVisibleRange(
                  { from: cancelTarget - 14 * 86400, to: cancelTarget - 14 * 86400 + 3600 },
                  { rejectByTimeout: 30000 },
                )
                .then(
                  () => "completed",
                  () => "cancelled",
                );
            },
            { m5, cancelTarget },
          );
          await frame.waitForFunction(
            () => MWNativeNavigation.diagnostics().pending > 0,
          );
          await frame.evaluate(
            (m5) => widget.chart(m5).executeActionById("timeScaleReset"),
            m5,
          );
          item.returnLatestOutcome = await frame.evaluate(() => __oldToLatest);
          assert.equal(item.returnLatestOutcome, "cancelled");
          await page.waitForTimeout(5500);
          await settle();
          item.latestView = await snapshot();
          assert.ok(
            item.latestView.charts[m5].range.to > target + 100 * 86400,
            "old delayed range must not override return to latest",
          );
          await frame.evaluate(
            ({ m5, target }) =>
              widget
                .chart(m5)
                .setVisibleRange({ from: target - 1800, to: target + 1800 }),
            { m5, target },
          );
          await settle();
          phase = "studies";
          await frame.evaluate(async (m5) => {
            for (const [name, params] of [
              ["Moving Average", { length: 200 }],
              ["Relative Strength Index", { length: 14 }],
              ["MACD", {}],
              ["守望 Python SMA", { period: 200 }],
            ])
              await widget.chart(m5).createStudy(name, false, false, params);
            await widget
              .chart(m5)
              .createShape(
                { time: widget.chart(m5).getVisibleRange().from, price: 1.1 },
                { shape: "horizontal_line" },
              );
          }, m5);
          await settle();
          await page.waitForTimeout(3000);
          item.studies = await snapshot();
          assert.ok(item.studies.charts[m5].studies.length >= 4);
          phase = "held-drag";
          const held = await box(m5, true),
            beforeHeld = await snapshot();
          await page.mouse.move(
            held.x + held.width * 0.7,
            held.y + held.height * 0.5,
          );
          await page.mouse.down();
          await page.mouse.move(
            held.x + held.width * 0.2,
            held.y + held.height * 0.5,
            { steps: 20 },
          );
          await page.waitForTimeout(200);
          item.held = await snapshot();
          await page.mouse.up();
          await settle();
          assert.notEqual(
            item.held.charts[m5].range.from,
            beforeHeld.charts[m5].range.from,
            "held drag must move immediately",
          );
          phase = "revision";
          await frame.evaluate((m5) => {
            globalThis.__resetCount = 0;
            globalThis.__revisedBars = [];
            const getBars = feed.getBars;
            feed.getBars = function (s, r, p, cb, err) {
              return getBars.call(
                this,
                s,
                r,
                p,
                (bars, meta) => {
                  if (r === "5" && s.ticker?.startsWith("MWP:"))
                    __revisedBars.push(...bars);
                  cb(bars, meta);
                },
                err,
              );
            };
            const chart = widget.chart(m5),
              original = chart.resetData;
            chart.resetData = function (...args) {
              __resetCount++;
              return original.apply(this, args);
            };
          }, m5);
          const rangeBefore = await snapshot();
          if (process.env.NATIVE_REVISION_SCRIPT) {
            const at = Math.floor(
              (rangeBefore.charts[m5].range.from +
                rangeBefore.charts[m5].range.to) *
                500,
            );
            item.injection = JSON.parse(
              execFileSync(
                "sg",
                [
                  "docker",
                  "-c",
                  `docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml exec -T --user 0 api python /private/revise.py ${at}`,
                ],
                { encoding: "utf8" },
              ),
            );
            await frame.waitForFunction(() => __resetCount > 0, null, {
              timeout: 60000,
            });
            await settle();
            item.revised = await snapshot();
            item.resetCount = await frame.evaluate(() => __resetCount);
            assert.ok(
              Math.abs(
                item.revised.charts[m5].range.from -
                  rangeBefore.charts[m5].range.from,
              ) < 600,
              "real revision must restore history view",
            );
            item.revisedCallback = await frame.evaluate(
              (start) => __revisedBars.filter((b) => b.time === start).at(-1),
              item.injection.start,
            );
            assert.equal(
              item.revisedCallback?.close,
              Number(item.injection.close),
              "native callback must receive exact PG revised close",
            );
          }
          await changeCapacity(200000);
          phase = "save-reopen";
          await frame.evaluate(
            () =>
              new Promise((resolve, reject) =>
                widget.saveChartToServer(resolve, reject),
              ),
          );
          item.saved = await snapshot();
          await page.reload();
          frame = undefined;
          for (let attempt = 0; attempt < 200 && !frame; attempt++) {
            frame = page.frames().find((f) => f.url().startsWith(CHART + "/"));
            if (!frame) await page.waitForTimeout(100);
          }
          await settle();
          item.reopened = await snapshot();
          assert.equal(
            item.reopened.charts[m5].studies.length,
            item.saved.charts[m5].studies.length,
          );
          assert.equal(
            item.reopened.charts[m5].shapes.length,
            item.saved.charts[m5].shapes.length,
          );
          if (process.env.NATIVE_PREFIX_REVISION === "1") {
            phase = "prefix-revision";
            await require("./native-prefix-revision.cjs")({
              frame,
              settle,
              item,
              save,
              m5,
            });
          }
        }
        item.passed = true;
        save();
      } catch (error) {
        item.failure = String(error);
        item.stack = error.stack;
        if (frame) item.failedSnapshot = await snapshot().catch(() => null);
        if (frame)
          item.lifecycle = await frame
            .evaluate(() => ({
              historyReloading,
              navigation: MWNativeNavigation.diagnostics(),
              work: [...providerHistoryWork.values()].map((w) => ({
                symbol: w.symbol,
                res: w.res,
                inflight: w.inflight,
                reloading: w.reloading,
              })),
            }))
            .catch(() => null);
        if (frame)
          item.notices = await frame
            .evaluate(() => activeNotices)
            .catch(() => null);
        if (native)
          item.modelState = await native
            .evaluate(() =>
              [...__syncModels.values()]
                .filter((v) => v.canvas.isConnected)
                .map(({ m }) => ({
                  res: m.interval(),
                  scroll: !!m._scrollingState,
                  range: !!m._lastGotoTimeRange,
                  left: m.mainSeries().bars().firstIndex(),
                  right: m.mainSeries().bars().lastIndex(),
                })),
            )
            .catch(() => null);
        await page
          .screenshot({ path: OUT.replace(".json", "-failed.png") })
          .catch(() => {});
        save();
        throw error;
      } finally {
        await Promise.allSettled(jobs);
        save();
        await context.close();
      }
    }
  } finally {
    await browser.close();
    save();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
