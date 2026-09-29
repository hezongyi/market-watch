// Development acceptance: real history date jump and viewport retention.
// Creates a workspace and requests EURUSD M1 around 2026-08-12; requires local ports 5188/5187.
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
    await page.evaluate(async () => {
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
          interval: "5",
        },
      });
      const catalog = await (
        await fetch("/api/market-data/catalog?query=NZD_USD")
      ).json();
      return catalog;
    }),
  );
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
  const assert = require("node:assert/strict");
  const symbol = process.env.MARKET_WATCH_HISTORY_SYMBOL || "EURUSD";
  const resolution = process.env.MARKET_WATCH_HISTORY_RESOLUTION || "1";
  await frame.evaluate(
    async ({ symbol, resolution }) => {
      await widget.chart(0).setSymbol(symbol);
      await widget.chart(0).setResolution(resolution);
      await new Promise((resolve) => widget.chart(0).dataReady(resolve));
    },
    { symbol, resolution },
  );
  console.log("HISTORY_CASE", JSON.stringify({ symbol, resolution }));
  for (const key of Object.keys(historyMetrics)) historyMetrics[key] = 0;
  const started = Date.now();
  const target = {
    from: Date.parse("2026-08-12T08:00:00Z") / 1000,
    to: Date.parse("2026-08-12T14:00:00Z") / 1000,
  };
  const timeout = Number(process.env.MARKET_WATCH_HISTORY_TIMEOUT_MS || 60000);
  console.log("JUMP_BUDGET_MS", timeout);
  await frame.evaluate(
    async ({ target, timeout }) => {
      await widget
        .chart(0)
        .setVisibleRange(target, { rejectByTimeout: timeout });
    },
    { target, timeout },
  );
  console.log("JUMP_MS", Date.now() - started);
  console.log("JUMP_METRICS", JSON.stringify(historyMetrics));
  await page.waitForTimeout(20000);
  const result = await frame.evaluate(() => ({
    range: widget.chart(0).getVisibleRange(),
    pending: [...pendingHistory.values()],
    failed: [...failedHistory.values()],
  }));
  console.log("HISTORY_RESULT", JSON.stringify(result));
  const tolerance = Number(resolution) * 60;
  assert.ok(
    Number.isFinite(tolerance),
    "this intraday case needs a minute resolution",
  );
  assert.ok(
    Math.abs(result.range.to - target.to) <= tolerance,
    "historical date jump must retain the requested right boundary after history loads",
  );
  assert.ok(
    Math.abs(result.range.from - target.from) <= tolerance,
    "historical date jump must retain the requested left boundary",
  );
  assert.equal(result.pending.length, 0);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(errors, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
