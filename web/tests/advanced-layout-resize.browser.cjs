// Development theme persistence regression. Sets shared preference to Light.
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
  const base = process.env.MARKET_WATCH_TEST_URL || "http://127.0.0.1:5188";
  const cutoff = Number(process.env.MARKET_WATCH_HISTORY_BEFORE || 0);
  if (cutoff)
    await page.route(/\/api\/(market-data\/history|charts\/data)$/, (route) => {
      const q = route.request().postDataJSON();
      return route.continue({
        postData: JSON.stringify({
          ...q,
          before: Math.min(q.before || cutoff, cutoff),
        }),
      });
    });
  const errors = [];
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
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
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
        name: "分隔线拖动验收",
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
  await page.goto(base + "/advanced-charts");
  await page.waitForTimeout(15000);
  let frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await frame.evaluate(() => widget.setLayout("2h"));
  await frame.waitForFunction(
    () => widget.chartsCount() === 2 && widget.chart(1).dataReady(),
  );
  const assert = require("node:assert/strict");
  const native = page
    .frames()
    .find((candidate) => candidate.url().startsWith("blob:"));
  const handle = native
    .locator('[class*="chart-widget-collection-border--"]')
    .first();
  const box = await handle.boundingBox();
  assert.ok(box);
  const before = await frame.evaluate(() =>
    widget.chart(0).getTimeScale().width(),
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await frame.waitForFunction(
    (before) => widget.chart(0).getTimeScale().width() > before + 90,
    before,
  );
  const resized = await frame.evaluate(() =>
    [0, 1].map((i) => widget.chart(i).getTimeScale().width()),
  );
  await page.waitForTimeout(1500);
  await frame.waitForFunction(
    () => !loading && !nativeSaving && !rangeGuard?.busy(),
  );
  await frame.waitForFunction(
    () => {
      const a = widget.chart(0).getVisibleRange(),
        b = widget.chart(1).getVisibleRange();
      return Math.abs(a.from - b.from) <= 300 && Math.abs(a.to - b.to) <= 300;
    },
    null,
    { timeout: 10000 },
  );
  await frame.evaluate(
    () =>
      new Promise((resolve, reject) =>
        widget.saveChartToServer(resolve, (error) =>
          reject(Error(JSON.stringify(error))),
        ),
      ),
  );
  await page.reload();
  await page.waitForTimeout(15000);
  frame = page
    .frames()
    .find((candidate) => candidate.url().includes(":5187/?"));
  await frame.waitForFunction(
    () =>
      ready &&
      !loading &&
      widget.chartsCount() === 2 &&
      widget.chart(1).dataReady(),
  );
  const restored = await frame.evaluate(() =>
    [0, 1].map((i) => widget.chart(i).getTimeScale().width()),
  );
  for (let i = 0; i < 2; i++)
    assert.ok(
      Math.abs(restored[i] - resized[i]) <= 2,
      JSON.stringify({ resized, restored }),
    );
  const sync = await frame.evaluate(() => ({
    enabled: widget.dateRangeSync().value(),
    ranges: [0, 1].map((i) => widget.chart(i).getVisibleRange()),
  }));
  assert.equal(sync.enabled, true);
  assert.ok(Math.abs(sync.ranges[0].from - sync.ranges[1].from) <= 300);
  assert.ok(Math.abs(sync.ranges[0].to - sync.ranges[1].to) <= 300);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/mw-layout-resized.png" });
  console.log("MOUSE_RESIZE_RESTORED", { before, resized, restored });
  console.log(
    "RESIZED_SYNC_STATE",
    await frame.evaluate(() => ({
      timeSync: widget.timeSync().value(),
      rangeSync: widget.dateRangeSync().value(),
      ranges: [0, 1].map((i) => widget.chart(i).getVisibleRange()),
    })),
  );
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
