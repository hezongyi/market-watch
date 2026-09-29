// Native initial monthly request sizing. History HTTP is intercepted; no historical download.
// Creates an unsaved-state monthly workspace; requires development ports 5188/5187.
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
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
  page.on("pageerror", (e) => errors.push(e.message));
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
          name: "按需历史验收 NZDUSD",
        });
        await post("/advanced-charts/workspaces/" + row.id + "/save", {
          name: row.name,
          revision: row.revision,
          document: {
            engine: "tv31",
            schemaVersion: 1,
            symbol: "OANDA:NZD_USD",
            interval: resolution,
          },
        });
        const catalog = await (
          await fetch("/api/market-data/catalog?query=NZD_USD")
        ).json();
        return catalog;
      },
      process.env.MARKET_WATCH_SWITCH_PERIOD
        ? "5"
        : process.env.MARKET_WATCH_TEST_RESOLUTION || "1M",
    ),
  );
  const captured = [];
  await page.route("**/api/market-data/history", async (route) => {
    const query = route.request().postDataJSON();
    if (process.env.MARKET_WATCH_SWITCH_PERIOD && query.timeframe === "M5")
      return route.continue();
    captured.push(query);
    await route.fulfill({
      json: {
        status: "error",
        bars: [],
        error: "验收拦截下载",
        failed_task_ids: [],
      },
    });
  });
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(15000);
  if (process.env.MARKET_WATCH_SWITCH_PERIOD) {
    const frame = page.frames().find((f) => f.url().includes(":5187/?"));
    await frame.waitForFunction(() => ready && !loading, null, {
      timeout: 60000,
    });
    if (process.env.MARKET_WATCH_INTERVAL_RESET_PROBE === "1")
      await frame.evaluate(() => {
        prepareHistoryViewport = undefined;
        const chart = widget.chart(0);
        chart.onIntervalChanged().subscribe(null, (resolution) => {
          if (resolution !== "1M") return;
          console.error(
            "INTERVAL_RESET_STATE",
            JSON.stringify({
              ready: chart.dataReady(),
              range: chart.getVisibleRange(),
            }),
          );
          const scale = chart.getTimeScale();
          scale.setBarSpacing(scale.width() / 3);
          widget.resetCache();
          chart.resetData();
        });
      });
    if (process.env.MARKET_WATCH_RESET_BEFORE_PERIOD_PROBE === "1") {
      await frame.evaluate(async () => {
        prepareHistoryViewport = undefined;
        const chart = widget.chart(0);
        const scale = chart.getTimeScale();
        scale.setBarSpacing(scale.width() / 3);
        await new Promise((resolve) => setTimeout(resolve, 100));
        widget.resetCache();
        chart.resetData();
      });
      await page.waitForTimeout(3000);
      await frame.waitForFunction(() => widget.chart(0).dataReady());
    }
    if (process.env.MARKET_WATCH_RESET_BUDGET_PROBE === "1")
      await frame.evaluate(() => {
        prepareHistoryViewport = undefined;
        const original = feed.getBars;
        let reset = false;
        feed.getBars = async (symbol, resolution, period, callback, error) => {
          if (resolution !== "1M" || reset || period.countBack <= 4)
            return original(symbol, resolution, period, callback, error);
          reset = true;
          const chart = widget.chart(0);
          const scale = chart.getTimeScale();
          scale.setBarSpacing(scale.width() / 3);
          error("Superseded by public data reset probe");
          await new Promise((resolve) => setTimeout(resolve, 100));
          widget.resetCache();
          chart.resetData();
        };
      });
    if (process.env.MARKET_WATCH_FEED_BUDGET_PROBE === "1")
      await frame.evaluate(() => {
        widget
          .chart(0)
          .onIntervalChanged()
          .subscribe(null, (resolution, parameters) => {
            console.error(
              "BUDGET_PROBE_INTERVAL",
              JSON.stringify({ resolution, parameters }),
            );
          });
        const original = feed.getBars;
        let rebuilt = false;
        feed.getBars = async (symbol, resolution, period, callback, error) => {
          if (resolution !== "1M" || rebuilt || period.countBack <= 4)
            return original(symbol, resolution, period, callback, error);
          rebuilt = true;
          console.error(
            "BUDGET_PROBE_OLD_REQUEST",
            JSON.stringify({
              period,
              chartResolution: widget.chart(0).resolution(),
              ready,
              loading,
            }),
          );
          const scale = widget.chart(0).getTimeScale();
          scale.setBarSpacing(scale.width() / 3);
          await new Promise((resolve) => setTimeout(resolve, 100));
          const state = await new Promise((resolve) => widget.save(resolve));
          const loaded = widget.load(state);
          error("Superseded by bounded viewport reload");
          await loaded;
        };
      });
    if (process.env.MARKET_WATCH_RAPID_HIGH_PERIOD) {
      for (const period of ["1D", "1W", "1M", "1D", "1M"]) {
        await frame.evaluate((period) => {
          widget
            .chart(0)
            .setResolution(period)
            .catch(() => {});
        }, period);
        await page.waitForTimeout(100);
      }
    } else
      await frame.evaluate((resolution) => {
        widget
          .chart(0)
          .setResolution(resolution)
          .catch(() => {});
      }, process.env.MARKET_WATCH_TEST_RESOLUTION || "1M");
    await page.waitForTimeout(3000);
    if (process.env.MARKET_WATCH_RELOAD_BUDGET_PROBE === "1") {
      console.log("BEFORE_RELOAD_REQUESTS", JSON.stringify(captured));
      captured.length = 0;
      await frame.evaluate(async () => {
        const scale = widget.chart(0).getTimeScale();
        scale.setBarSpacing(scale.width() / 3);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const state = await new Promise((resolve) => widget.save(resolve));
        await widget.load(state);
      });
      await page.waitForTimeout(3000);
    }
  }
  console.log("HIGH_PERIOD_REQUESTS", JSON.stringify(captured));
  require("node:assert/strict").ok(captured.length);
  const resolution = process.env.MARKET_WATCH_TEST_RESOLUTION || "1M";
  const limits = { "1D": 100, "1W": 16, "1M": 4 };
  const frames = { "1D": "D1", "1W": "W1", "1M": "MN" };
  require("node:assert/strict").ok(
    captured.every((q) =>
      process.env.MARKET_WATCH_RAPID_HIGH_PERIOD
        ? q.limit <= ({ D1: 100, W1: 16, MN: 4 }[q.timeframe] || 0)
        : q.timeframe === frames[resolution] && q.limit <= limits[resolution],
    ),
  );
  require("node:assert/strict").deepEqual(errors, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
