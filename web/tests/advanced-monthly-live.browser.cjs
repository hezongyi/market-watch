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
    await page.evaluate(async (resolution) => {
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
    }, resolution),
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
