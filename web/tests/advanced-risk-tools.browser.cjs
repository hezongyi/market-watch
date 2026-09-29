// Development drawing persistence check; horizontal lines are price-only, trend lines retain both anchors.
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
  await page.addInitScript(() => {
    window.renderedChartText = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      window.renderedChartText.push(String(text));
      if (window.renderedChartText.length > 10000)
        window.renderedChartText.splice(0, 5000);
      return original.call(this, text, ...args);
    };
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
  let frame = page.frames().find((f) => f.url().includes(":5187/?"));
  const assert = require("node:assert/strict");
  await frame.evaluate(async () => {
    const c = widget.chart(0),
      range = c.getVisibleRange();
    const width = range.to - range.from;
    for (const [shape, left] of [
      ["long_position", 0.15],
      ["short_position", 0.58],
    ]) {
      const id = await c.createMultipointShape(
        [
          { time: range.from + width * left, price: 0.565 },
          { time: range.from + width * (left + 0.22), price: 0.565 },
        ],
        { shape },
      );
      c.getShapeById(id).setProperties({
        stopLevel: 100,
        profitLevel: 250,
        alwaysShowStats: true,
      });
    }
    c.getPanes()[0]
      .getMainSourcePriceScale()
      .setVisiblePriceRange({ from: 0.56, to: 0.57 });
  });
  await page.waitForTimeout(1500);
  const ui = frame.childFrames()[0];
  const texts = await ui.evaluate(() => [...new Set(window.renderedChartText)]);
  console.log("RISK_RENDERED_TEXT", JSON.stringify(texts));
  await page.screenshot({ path: "/tmp/mw-risk-tools.png" });
  assert.ok(
    texts.includes("风险/回报比：2.5"),
    "Canvas must render the expected reward/risk ratio",
  );
  const riskPercent = ((0.001 / 0.565) * 100).toFixed(3);
  const rewardPercent = ((0.0025 / 0.565) * 100).toFixed(3);
  assert.ok(
    texts.some((text) =>
      text.startsWith(`停止：0.00100 (${riskPercent}%) 100`),
    ),
    "Stop distance and percentage must match entry price",
  );
  assert.ok(
    texts.some((text) =>
      text.startsWith(`目标：0.00250 (${rewardPercent}%) 250`),
    ),
    "Target distance and percentage must match entry price",
  );
  for (const level of ["0.56500", "0.56400", "0.56750", "0.56600", "0.56250"])
    assert.ok(
      texts.includes(level),
      `Expected entry/stop/target level ${level}`,
    );
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  await page.reload();
  await page.waitForTimeout(15000);
  frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await frame.waitForFunction(() => ready && !loading, null, {
    timeout: 60000,
  });
  const tools = await frame.evaluate(() => {
    const c = widget.chart(0);
    return c
      .getAllShapes()
      .map((shape) => ({
        name: shape.name,
        points: c.getShapeById(shape.id).getPoints(),
        props: c.getShapeById(shape.id).getProperties(),
      }));
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "long_position",
    "short_position",
  ]);
  for (const tool of tools) {
    assert.equal(tool.props.stopLevel, 100);
    assert.equal(tool.props.profitLevel, 250);
    assert.equal(tool.props.alwaysShowStats, true);
    assert.equal(tool.points[0].price, 0.565);
  }
  assert.deepEqual(errors, []);
  console.log("Long and short risk tools rendered and restored");
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
