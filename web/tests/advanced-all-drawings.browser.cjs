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
  const drawn = await frame.evaluate(async () => {
    const c = widget.chart(0),
      r = c.getVisibleRange();
    await c.createShape(
      { time: r.to - 3600, price: 0.565 },
      { shape: "horizontal_line" },
    );
    await c.createMultipointShape(
      [
        { time: r.to - 7200, price: 0.563 },
        { time: r.to - 3600, price: 0.566 },
      ],
      { shape: "trend_line" },
    );
    const points = [
      { time: r.to - 7200, price: 0.563 },
      { time: r.to - 3600, price: 0.566 },
    ];
    for (const shape of ["ray", "rectangle", "fib_retracement"])
      await c
        .createMultipointShape(
          points.map((p) => ({ ...p })),
          { shape },
        )
        .catch((e) => {
          throw Error(shape + ": " + e.message);
        });
    await c.createMultipointShape(
      [...points, { time: r.to - 3600, price: 0.568 }],
      { shape: "parallel_channel" },
    );
    for (const shape of ["long_position", "short_position"])
      await c
        .createMultipointShape(
          points.map((p) => ({ ...p })),
          { shape },
        )
        .catch((e) => {
          throw Error(shape + ": " + e.message);
        });
    await c.createShape(
      { time: r.to - 3600, price: 0.565 },
      { shape: "text", text: "画线恢复验收" },
    );
    return c
      .getAllShapes()
      .map((x) => ({ name: x.name, points: c.getShapeById(x.id).getPoints() }));
  });
  console.log("DRAWN", JSON.stringify(drawn));
  await page.waitForTimeout(10000);
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  await page.reload();
  await page.waitForTimeout(15000);
  frame = page.frames().find((f) => f.url().includes(":5187/?"));
  const restored = await frame.evaluate(() => {
    const c = widget.chart(0);
    return c
      .getAllShapes()
      .map((x) => ({ name: x.name, points: c.getShapeById(x.id).getPoints() }));
  });
  console.log("RESTORED_DRAWINGS", JSON.stringify(restored));
  const normalize = (shapes) =>
    shapes.map((s) => ({
      name: s.name,
      points: s.points.map((p) =>
        s.name === "horizontal_line" ? { price: p.price } : p,
      ),
    }));
  require("node:assert/strict").deepEqual(
    normalize(restored),
    normalize(drawn),
  );
  require("node:assert/strict").equal(restored.length, 9);
  require("node:assert/strict").deepEqual(errors, []);
  console.log("All requested drawing families restored their anchor points");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
