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
  phase = "move-mixed-viewport";
  const windowHours = Number(process.env.MARKET_WATCH_VIEWPORT_HOURS || 24);
  assert.ok(Number.isFinite(windowHours) && windowHours > 0);
  const target = await frame.evaluate(async (windowHours) => {
    const r = widget.chart(0).getVisibleRange();
    const target = { from: r.to - 86400 - windowHours * 3600, to: r.to - 86400 };
    await widget.chart(0).setVisibleRange(target, { rejectByTimeout: 20000 });
    return target;
  }, windowHours);
  await page.waitForTimeout(5000);
  const moved = await frame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) => ({
      symbol: widget.chart(i).symbol(),
      resolution: widget.chart(i).resolution(),
      range: widget.chart(i).getVisibleRange(),
    })),
  );
  console.log("MOVED_RANGES", JSON.stringify({ target, moved }));
  // Compare same-symbol panes: different instruments can have different sessions.
  for (const pane of moved) {
    const reference = moved.find((other) => other.symbol === pane.symbol);
    const tolerance = Number(pane.resolution) * 60;
    assert.ok(Math.abs(pane.range.from - reference.range.from) <= tolerance,
      `${pane.symbol} ${pane.resolution}: left boundary did not synchronize`);
    assert.ok(Math.abs(pane.range.to - target.to) <= tolerance,
      `${pane.symbol} ${pane.resolution}: right boundary did not synchronize`);
  }
  phase = "move-with-sync-disabled";
  await frame.evaluate(async () => {
    widget.dateRangeSync().setValue(false);
    widget.timeSync().setValue(false);
    const r = widget.chart(0).getVisibleRange();
    await widget.chart(0).setVisibleRange(
      { from: r.from - 3600, to: r.to - 3600 }, { rejectByTimeout: 20000 });
  });
  await page.waitForTimeout(2000);
  const unsynced = await frame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i).getVisibleRange()));
  assert.notDeepEqual(unsynced[0], moved[0].range);
  assert.deepEqual(unsynced.slice(1), moved.slice(1).map((p) => p.range));
  assert.deepEqual(errors, []);
  console.log("Mixed-period viewport movement and disabled synchronization passed");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
