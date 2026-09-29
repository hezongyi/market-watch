// Manual development-only acceptance: creates a test workspace; requires local ports 5188/5187.
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
  let phase = "initial-load";
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 700));
  });
  page.on("response", async (r) => {
    if (
      r.url().includes("/api/charts/data") ||
      r.url().includes("/api/market-data/history")
    ) {
      const j = await r.json().catch(() => ({}));
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
    console.log("MIXED_ERROR_STACK", phase, e.stack);
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
  phase = "expand-layout";
  await frame.evaluate(() => widget.setLayout("8"));
  await page.waitForTimeout(10000);
  require("node:assert/strict").equal(
    await frame.evaluate(() => widget.chartsCount()),
    8,
  );
  const specs = [
    ["EURUSD", "5"],
    ["XAUUSD", "5"],
    ["BTCUSDT", "5"],
    ["EURUSD", "15"],
    ["XAUUSD", "15"],
    ["BTCUSDT", "15"],
    ["EURUSD", "30"],
    ["OANDA:NZD_USD", "5"],
  ];
  phase = "configure-panes";
  await frame.evaluate(async (specs) => {
    widget.symbolSync().setValue(false);
    widget.intervalSync().setValue(false);
    for (let i = 0; i < specs.length; i++) {
      const c = widget.chart(i);
      await c.setSymbol(specs[i][0], { doNotActivateChart: true });
      await c.setResolution(specs[i][1], { doNotActivateChart: true });
    }
  }, specs);
  await page.waitForTimeout(15000);
  const state = await frame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) => ({
      symbol: widget.chart(i).symbol(),
      resolution: widget.chart(i).resolution(),
      range: widget.chart(i).getVisibleRange(),
    })),
  );
  const assert = require("node:assert/strict");
  console.log("MIXED_PANES", JSON.stringify(state));
  assert.deepEqual(
    state.map((s) => [s.symbol, s.resolution]),
    specs,
  );
  assert.ok(state.every((s) => s.range.to > s.range.from && s.range.from > 0));
  assert.equal(
    await frame.evaluate(() => widget.dateRangeSync().value()),
    true,
  );
  assert.equal(await frame.evaluate(() => rangeGuard.busy()), false);
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  phase = "reload-synchronized";
  await page.reload();
  await page.waitForTimeout(15000);
  const reloaded = page.frames().find((f) => f.url().includes(":5187/?"));
  assert.equal(await reloaded.evaluate(() => widget.chartsCount()), 8);
  assert.equal(
    await reloaded.evaluate(() => widget.dateRangeSync().value()),
    true,
  );
  assert.deepEqual(
    await reloaded.evaluate(() =>
      Array.from({ length: widget.chartsCount() }, (_, i) => [
        widget.chart(i).symbol(),
        widget.chart(i).resolution(),
      ]),
    ),
    specs,
  );
  phase = "disable-sync-change-period";
  await reloaded.evaluate(async () => {
    widget.dateRangeSync().setValue(false);
    await widget.chart(0).setResolution("15", { doNotActivateChart: true });
  });
  await page.waitForTimeout(3000);
  assert.equal(
    await reloaded.evaluate(() => widget.dateRangeSync().value()),
    false,
  );
  assert.equal(await reloaded.evaluate(() => rangeGuard.busy()), false);
  await reloaded.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  phase = "reload-unsynchronized";
  await page.reload();
  await page.waitForTimeout(15000);
  const disabledFrame = page.frames().find((f) => f.url().includes(":5187/?"));
  assert.equal(
    await disabledFrame.evaluate(() => widget.dateRangeSync().value()),
    false,
  );
  assert.deepEqual(errors, []);
  console.log("Eight mixed symbol/resolution panes loaded with valid ranges");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
