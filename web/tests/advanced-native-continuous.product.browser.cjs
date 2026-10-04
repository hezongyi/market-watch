// Isolated full product sync acceptance. The licensed bundle is only observed.
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
            !rangeGuard.busy() &&
            !edgeGuard.busy() &&
            !MWNativeNavigation.busy() &&
            Array.from({ length: widget.chartsCount() }, (_, i) =>
              widget.chart(i).dataReady(),
            ).every(Boolean),
          null,
          { timeout: 900000 },
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
        await frame.evaluate(async () => {
          await widget
            .chart(0)
            .setVisibleRange({
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
        item.hoverRequests = item.http.slice(beforeHover);
        assert.ok(
          item.hoverRequests.every(
            (r) => !r.query?.countBack || r.query.countBack < 20000,
          ),
          "hover must not reload historical corridor",
        );
        await page.screenshot({ path: OUT.replace(".json", "-hover.png") });
        item.passed = true;
        save();
      } catch (error) {
        item.failure = String(error);
        item.stack = error.stack;
        if (frame) item.failedSnapshot = await snapshot().catch(() => null);
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
