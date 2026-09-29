// Real D1/W1/MN initialization and workspace restoration; downloads missing development history.
// Creates an unsaved-state monthly workspace; requires development ports 5188/5187.
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const resolution = process.env.MARKET_WATCH_TEST_RESOLUTION || "1M";
  require("node:assert/strict").ok(["1D", "1W", "1M"].includes(resolution));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
  });
  const errors = [];
  let phase = "initial";
  const historyMetrics = {
    requests: 0,
    pending: 0,
    ready: 0,
    dataPages: 0,
    returnedBars: 0,
  };
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 700));
  });
  page.on("response", async (r) => {
    if (
      r.url().includes("/api/charts/data") ||
      r.url().includes("/api/market-data/history")
    ) {
      const j = await r.json().catch(() => ({}));
      if (r.url().includes("/api/market-data/history"))
        console.log(
          "MONTH_REQUEST",
          phase,
          JSON.stringify({
            query: r.request().postDataJSON(),
            status: j.status,
            coverageStart: j.requested_start,
            cursor: j.next_cursor,
            starts: j.bars?.map((b) => b.start),
          }),
        );
      if (r.url().includes("/api/market-data/history")) {
        historyMetrics.requests++;
        if (j.status === "pending") historyMetrics.pending++;
        if (j.status === "ready") historyMetrics.ready++;
      } else {
        historyMetrics.dataPages++;
        historyMetrics.returnedBars += j.bars?.length || 0;
      }
      console.log(
        "RESPONSE",
        r.status(),
        r.url(),
        j.status,
        j.bars?.length,
        j.detail,
      );
    }
  });
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("MONTH_ERROR", phase, e.stack);
  });
  await page.goto("http://127.0.0.1:5188/");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync(
          process.env.MARKET_WATCH_TEST_CREDENTIALS ||
            require("node:path").resolve(
              __dirname,
              "../../../market-watch/artifacts/local-credentials.json",
            ),
        ),
      ).password,
    );
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.waitForTimeout(1000);
  console.log(
    await page.evaluate(
      async (resolution) => {
        const session = await (await fetch("/api/session")).json();
        async function post(path, body) {
          let r = await fetch("/api" + path, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrf,
            },
            body: JSON.stringify(body),
          });
          return r.json();
        }
        const row = await post("/advanced-charts/workspaces", {
          name: `真实高周期加载验收 EURUSD ${resolution}`,
        });
        await post("/advanced-charts/workspaces/" + row.id + "/save", {
          name: row.name,
          revision: row.revision,
          document: {
            engine: "tv31",
            schemaVersion: 1,
            symbol: "EURUSD",
            interval: resolution,
          },
        });
        const catalog = await (
          await fetch("/api/market-data/catalog?query=NZD_USD")
        ).json();
        return catalog;
      },
      process.env.MARKET_WATCH_START_M5 ? "5" : resolution,
    ),
  );
  const started = Date.now();
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(3000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await frame.waitForFunction(
    () => ready && widget.chart(0).getVisibleRange().from > 0,
    null,
    { timeout: 180000 },
  );
  if (process.env.MARKET_WATCH_EXPORT_LIVE_CHECK) {
    const assert = require("node:assert/strict");
    await frame.evaluate(() =>
      widget
        .chart(0)
        .createStudy("守望 Python EMA", false, false, { period: 20 }),
    );
    const native = frame.childFrames()[0];
    await native
      .locator("button:visible")
      .filter({ hasText: "导出 CSV" })
      .click();
    await page.getByLabel("开始时间（含）").fill("2026-09-28T12:00");
    await page.getByLabel("结束时间（不含）").fill("2026-09-28T13:00");
    await page.getByLabel("附带当前图表的 Python 指标").check();
    const downloaded = page.waitForEvent("download", { timeout: 120000 });
    await page.getByRole("button", { name: "下载 CSV", exact: true }).click();
    const file = await downloaded;
    const content = fs
      .readFileSync(await file.path(), "utf8")
      .replace(/^\uFEFF/, "");
    const lines = content
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(","));
    const header = lines.shift(),
      index = (name) => header.indexOf(name);
    assert.equal(lines.length, 12);
    const indicator = header.findIndex(
      (name) => name.startsWith("python:") && name.endsWith(":value"),
    );
    assert.ok(indicator >= 0);
    for (const [i, row] of lines.entries()) {
      assert.equal(row[index("instrument")], "EURUSD");
      assert.equal(row[index("timeframe")], "M5");
      assert.equal(
        Number(row[index("start_ms")]),
        Date.parse("2026-09-28T12:00:00Z") + i * 300000,
      );
      assert.ok(
        Number.isFinite(Number(row[indicator])) && row[indicator] !== "",
      );
    }
    assert.deepEqual(errors, []);
    await browser.close();
    console.log(
      "PASS: actual header export -> authenticated backend -> CSV download with 12 M5 bars and EMA",
    );
    return;
  }
  if (process.env.MARKET_WATCH_EXPORT_UI_CHECK) {
    await frame.evaluate(() =>
      widget
        .chart(0)
        .createStudy("守望 Python EMA", false, false, { period: 20 }),
    );
    let requests = 0,
      retried = 0,
      cancelledPhase = false,
      downloads = 0;
    page.on("download", () => downloads++);
    await page.route(
      "**/api/market-data/retry/11111111-1111-1111-1111-111111111111",
      async (route) => {
        retried++;
        await route.fulfill({ json: { ok: true } });
      },
    );
    await page.route("**/api/charts/export", async (route) => {
      const body = route.request().postDataJSON();
      require("node:assert/strict").equal(body.instrument, "EURUSD");
      require("node:assert/strict").ok(body.end > body.start);
      require("node:assert/strict").equal(body.indicators[0].name, "EMA");
      requests++;
      if (requests === 1)
        return route.fulfill({
          status: 409,
          json: {
            message: "测试补数失败",
            failed_task_ids: ["11111111-1111-1111-1111-111111111111"],
          },
        });
      if (requests === 2 || cancelledPhase)
        return route.fulfill({ status: 202, json: { status: "pending" } });
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: "start_ms,close\r\n60000,1.2345\r\n",
      });
    });
    const native = frame.childFrames()[0];
    await native
      .locator("button:visible")
      .filter({ hasText: "导出 CSV" })
      .click();
    await page.getByLabel("开始时间（含）").fill("2026-09-28T12:00");
    await page.getByLabel("结束时间（不含）").fill("2026-09-28T13:00");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 CSV", exact: true }).click();
    await page
      .getByRole("button", { name: "重试历史补数", exact: true })
      .click();
    await page.getByText("正在补齐历史行情", { exact: false }).waitFor();
    const file = await download;
    require("node:assert/strict").equal(
      fs.readFileSync(await file.path(), "utf8"),
      "start_ms,close\r\n60000,1.2345\r\n",
    );
    require("node:assert/strict").equal(requests, 3);
    require("node:assert/strict").equal(retried, 1);
    await page.screenshot({ path: "/tmp/mw-export-dialog.png" });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await native
      .locator("button:visible")
      .filter({ hasText: "导出 CSV" })
      .click();
    cancelledPhase = true;
    await page.getByRole("button", { name: "下载 CSV", exact: true }).click();
    await page.getByText("正在补齐历史行情", { exact: false }).waitFor();
    const beforeCancel = requests;
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.waitForTimeout(2500);
    require("node:assert/strict").equal(requests, beforeCancel);
    require("node:assert/strict").equal(downloads, 1);
    require("node:assert/strict").deepEqual(errors, []);
    await browser.close();
    console.log(
      "Export dialog pending, download bytes and Escape close passed",
    );
    return;
  }
  if (process.env.MARKET_WATCH_RAPID_PERIOD_CHECK) {
    const assert = require("node:assert/strict");
    const epoch = await frame.evaluate(async () => {
      const chart = widget.chart(0);
      await chart.createShape(
        { time: chart.getVisibleRange().to - 3600, price: 1.13 },
        { shape: "horizontal_line" },
      );
      return workspaceEpoch;
    });
    for (const period of ["15", "30", "60", "5", "15", "5"]) {
      await frame.evaluate((period) => {
        widget
          .chart(0)
          .setResolution(period)
          .catch(() => {});
      }, period);
      await page.waitForTimeout(100);
    }
    await frame.waitForFunction(
      () =>
        !loading &&
        !rangeGuard.busy() &&
        widget.chart(0).resolution() === "5" &&
        widget.chart(0).dataReady(),
      null,
      { timeout: 180000 },
    );
    await page.waitForTimeout(3000);
    const state = await frame.evaluate(() => ({
      epoch: workspaceEpoch,
      resolution: widget.chart(0).resolution(),
      shapes: widget.chart(0).getAllShapes().length,
      range: widget.chart(0).getVisibleRange(),
    }));
    assert.equal(state.epoch, epoch);
    assert.equal(state.resolution, "5");
    assert.equal(state.shapes, 1);
    assert.ok(state.range.to > state.range.from && state.range.from > 0);
    assert.deepEqual(errors, []);
    console.log("RAPID_PERIOD_RESULT", JSON.stringify(state));
    await browser.close();
    return;
  }
  if (process.env.MARKET_WATCH_START_M5) {
    if (process.env.MARKET_WATCH_PARTIAL_HISTORY_PROBE) {
      await frame.evaluate(async () => {
        prepareHistoryViewport = undefined;
        window.partialRequests = [];
        const chart = widget.chart(0);
        await chart.createShape(
          { time: chart.getVisibleRange().to - 3600, price: 1.13 },
          { shape: "horizontal_line" },
        );
        const original = feed.getBars;
        feed.getBars = (symbol, resolution, period, callback, error) => {
          if (resolution !== "1M")
            return original(symbol, resolution, period, callback, error);
          partialRequests.push({ ...period });
          if (partialRequests.length > 1) return; // Hold further requests for observation only.
          const scale = chart.getTimeScale();
          scale.setBarSpacing(scale.width() / 3);
          return original(
            symbol,
            resolution,
            { ...period, countBack: 4 },
            callback,
            error,
          );
        };
        chart.setResolution("1M").catch(() => {});
      });
      await page.waitForTimeout(10000);
      console.log(
        "PARTIAL_HISTORY_PROBE",
        JSON.stringify(
          await frame.evaluate(() => ({
            requests: partialRequests,
            ready: widget.chart(0).dataReady(),
            range: widget.chart(0).getVisibleRange(),
            undo: widget.undoRedoState(),
            shapes: widget.chart(0).getAllShapes().length,
          })),
        ),
      );
      await page.screenshot({ path: "/tmp/mw-partial-history.png" });
      require("node:assert/strict").deepEqual(errors, []);
      await browser.close();
      return;
    }
    let neighbor;
    if (process.env.MARKET_WATCH_TWO_PANES) {
      await frame.evaluate(async () => {
        await widget.setLayout("2h");
        widget.dateRangeSync().setValue(false);
        widget.timeSync().setValue(false);
      });
      await frame.waitForFunction(
        () => {
          try {
            return widget.chartsCount() === 2 && widget.chart(1).dataReady();
          } catch {
            return false;
          }
        },
        null,
        { timeout: 180000 },
      );
      await frame.evaluate(async () => {
        await widget.chart(1).setSymbol("XAUUSD", { doNotActivateChart: true });
        await widget.chart(1).setResolution("15", { doNotActivateChart: true });
      });
      await frame.waitForFunction(
        () => !rangeGuard.busy() && widget.chart(1).dataReady(),
      );
      neighbor = await frame.evaluate(async () => {
        const c = widget.chart(1);
        await c.createShape(
          { time: c.getVisibleRange().to - 3600, price: 4100 },
          { shape: "horizontal_line" },
        );
        return {
          symbol: c.symbol(),
          resolution: c.resolution(),
          range: c.getVisibleRange(),
        };
      });
    }
    const epoch = await frame.evaluate(() => workspaceEpoch);
    if (process.env.MARKET_WATCH_RESET_BEFORE_PERIOD_PROBE) {
      await frame.evaluate(async () => {
        prepareHistoryViewport = undefined;
        const chart = widget.chart(0);
        await chart.createShape(
          { time: chart.getVisibleRange().to - 3600, price: 1.12 },
          { shape: "horizontal_line" },
        );
        const scale = chart.getTimeScale();
        scale.setBarSpacing(scale.width() / 3);
        await new Promise((resolve) => setTimeout(resolve, 100));
        widget.resetCache();
        chart.resetData();
      });
      await page.waitForTimeout(2000);
      await frame.waitForFunction(() => widget.chart(0).dataReady());
    }
    await frame.evaluate(
      async ({ resolution, nativeClick }) => {
        const chart = widget.chart(0);
        await chart.createShape(
          { time: chart.getVisibleRange().to - 3600, price: 1.13 },
          { shape: "horizontal_line" },
        );
        window.periodUndoBefore = widget.undoRedoState();
        if (!nativeClick) chart.setResolution(resolution).catch(() => {});
      },
      {
        resolution,
        nativeClick: !!process.env.MARKET_WATCH_NATIVE_PERIOD_CLICK,
      },
    );
    if (process.env.MARKET_WATCH_NATIVE_PERIOD_CLICK) {
      const native = frame.childFrames()[0];
      await native.getByRole("button", { name: "5 分钟", exact: true }).click();
      await native
        .getByText({ "1D": "1 日", "1W": "1 周", "1M": "1 月" }[resolution], {
          exact: true,
        })
        .click();
    }
    await frame.waitForFunction(
      ({ epoch, resolution }) =>
        workspaceEpoch === epoch &&
        !rangeGuard?.busy() &&
        ready &&
        !loading &&
        widget.chart(0).resolution() === resolution &&
        widget.chart(0).dataReady(),
      {
        epoch,
        resolution,
      },
      { timeout: 180000 },
    );
    require("node:assert/strict").equal(
      await frame.evaluate(() => widget.chart(0).getAllShapes().length),
      process.env.MARKET_WATCH_RESET_BEFORE_PERIOD_PROBE ? 2 : 1,
    );
    if (neighbor) {
      const after = await frame.evaluate(() => {
        const c = widget.chart(1);
        return {
          symbol: c.symbol(),
          resolution: c.resolution(),
          range: c.getVisibleRange(),
        };
      });
      require("node:assert/strict").deepEqual(
        after,
        neighbor,
        "Unchanged neighboring pane must retain symbol, period and viewport",
      );
      require("node:assert/strict").equal(
        await frame.evaluate(() => widget.chart(1).getAllShapes().length),
        1,
      );
      require("node:assert/strict").equal(
        await frame.evaluate(() => widget.dateRangeSync().value()),
        false,
      );
    }
    const undo = await frame.evaluate(() => ({
      before: window.periodUndoBefore,
      after: widget.undoRedoState(),
    }));
    console.log("PERIOD_UNDO", JSON.stringify(undo));
    if (!neighbor && !process.env.MARKET_WATCH_RESET_BEFORE_PERIOD_PROBE)
      require("node:assert/strict").equal(
        undo.after.originalUndoText,
        "change resolution",
        "Single-pane period switch must not add internal sync commands to undo",
      );
    if (process.env.MARKET_WATCH_REQUIRE_UNDO)
      require("node:assert/strict").ok(
        undo.before.enableUndo && undo.after.enableUndo,
        "Period switch must preserve available undo history",
      );
    const visible = await frame.evaluate(
      (resolution) => ({
        range: widget.chart(0).getVisibleRange(),
        last: lastHistory.get(`EURUSD|${resolution}`),
      }),
      resolution,
    );
    console.log("SWITCH_VISIBLE", JSON.stringify(visible));
    require("node:assert/strict").ok(
      visible.range.from <= visible.last / 1000 &&
        visible.range.to >= visible.last / 1000,
      "Latest candle must be visible after switching",
    );
    if (process.env.MARKET_WATCH_EXERCISE_UNDO) {
      for (let step = 0; step < 10; step++) {
        const state = await frame.evaluate(() => ({
          undo: widget.undoRedoState(),
          shapes: widget.chart(0).getAllShapes().length,
          resolution: widget.chart(0).resolution(),
        }));
        console.log("PERIOD_UNDO_STEP", step, JSON.stringify(state));
        if (!state.shapes) break;
        require("node:assert/strict").ok(state.undo.enableUndo);
        await frame.evaluate(() => widget.chart(0).executeActionById("undo"));
        await frame.waitForFunction(
          () => !loading && widget.chart(0).dataReady(),
        );
        await page.waitForTimeout(300);
      }
      require("node:assert/strict").equal(
        await frame.evaluate(() => widget.chart(0).getAllShapes().length),
        0,
        "Undo must reach drawing creation from before the period switch",
      );
      require("node:assert/strict").deepEqual(errors, []);
      await browser.close();
      return;
    }
  }
  console.log("MONTH_READY_MS", Date.now() - started);
  const before = await frame.evaluate(() => ({
    resolution: widget.chart(0).resolution(),
    range: widget.chart(0).getVisibleRange(),
  }));
  console.log("MONTH_RANGE", JSON.stringify(before));
  require("node:assert/strict").equal(before.resolution, resolution);
  if (process.env.MARKET_WATCH_HISTORY_FAILURE === "1") {
    phase = "injected-history-failure";
    let injected = 0;
    await page.route("**/api/market-data/history", async (route) => {
      const body = route.request().postDataJSON();
      if (body.timeframe === "M30") {
        injected++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "error",
            error: "验收模拟行情暂时不可用",
            bars: [],
          }),
        });
      } else await route.continue();
    });
    await frame.evaluate(() => {
      window.switchAttempt = widget
        .chart(0)
        .setResolution("30")
        .catch(() => {});
    });
    await page.waitForTimeout(5000);
    require("node:assert/strict").ok(
      injected > 0,
      "Failure route must be exercised",
    );
    console.log(
      "FAILED_LOAD_SYNC",
      await frame.evaluate(() => ({
        busy: rangeGuard.busy(),
        desired: rangeGuard.desired(),
        actual: widget.dateRangeSync().value(),
      })),
    );
    await page.unroute("**/api/market-data/history");
    phase = "recover-after-history-failure";
    await frame.evaluate(async (resolution) => {
      await widget.chart(0).setResolution(resolution);
    }, resolution);
    await frame.waitForFunction(
      () => !rangeGuard.busy() && widget.chart(0).dataReady(),
      null,
      { timeout: 30000 },
    );
    require("node:assert/strict").equal(
      await frame.evaluate(() => widget.dateRangeSync().value()),
      true,
    );
    console.log("HISTORY_FAILURE_RECOVERED");
  }
  if (process.env.MARKET_WATCH_REAPPLY_RANGE === "1")
    await frame.evaluate(
      async (range) => widget.chart(0).setVisibleRange(range),
      {
        from:
          before.range.from -
          Number(process.env.MARKET_WATCH_RANGE_SHIFT_DAYS || 0) * 86400,
        to:
          before.range.to -
          Number(process.env.MARKET_WATCH_RANGE_SHIFT_DAYS || 0) * 86400,
      },
    );
  await page.waitForTimeout(2000);
  const savedRange = await frame.evaluate(() =>
    widget.chart(0).getVisibleRange(),
  );
  console.log("SAVED_RANGE", JSON.stringify(savedRange));
  console.log(
    "SAVED_SCALE",
    await frame.evaluate(() => {
      const scale = widget.chart(0).getTimeScale();
      return {
        spacing: scale.barSpacing(),
        offset: scale.rightOffset(),
        width: scale.width(),
      };
    }),
  );
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  phase = "reload";
  await page.reload();
  await page.waitForTimeout(3000);
  const restored = page.frames().find((f) => f.url().includes(":5187/?"));
  await restored.waitForFunction(
    () => ready && widget.chart(0).getVisibleRange().from > 0,
    null,
    { timeout: 180000 },
  );
  require("node:assert/strict").equal(
    await restored.evaluate(() => widget.chart(0).resolution()),
    resolution,
  );
  const restoredRange = await restored.evaluate(() =>
    widget.chart(0).getVisibleRange(),
  );
  console.log("MONTH_RESTORED_RANGE", JSON.stringify(restoredRange));
  console.log(
    "RESTORED_SCALE",
    await restored.evaluate(() => {
      const scale = widget.chart(0).getTimeScale();
      return {
        spacing: scale.barSpacing(),
        offset: scale.rightOffset(),
        width: scale.width(),
      };
    }),
  );
  require("node:assert/strict").deepEqual(restoredRange, savedRange);
  require("node:assert/strict").deepEqual(errors, []);
  console.log(
    `${resolution} real history initialized and saved workspace restored`,
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
