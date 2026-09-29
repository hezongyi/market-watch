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
    }, process.env.MARKET_WATCH_TEST_RESOLUTION || "1M"),
  );
  const captured = [];
  await page.route("**/api/market-data/history", async (route) => {
    captured.push(route.request().postDataJSON());
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
  console.log("HIGH_PERIOD_REQUESTS", JSON.stringify(captured));
  require("node:assert/strict").ok(captured.length);
  const resolution = process.env.MARKET_WATCH_TEST_RESOLUTION || "1M";
  const limits = {"1D":100,"1W":16,"1M":4};
  const frames = {"1D":"D1","1W":"W1","1M":"MN"};
  require("node:assert/strict").ok(captured.every((q) =>
    q.timeframe === frames[resolution] && q.limit <= limits[resolution]));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
