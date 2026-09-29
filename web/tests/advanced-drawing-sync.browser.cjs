// Development browser acceptance: native same-symbol M5/M15 drawing add/edit/delete synchronization.
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
  await frame.evaluate(() => widget.setLayout("2h"));
  await page.waitForTimeout(5000);
  await frame.evaluate(
    () =>
      new Promise((resolve) => widget.chart(1).setResolution("15", resolve)),
  );
  await page.waitForTimeout(5000);
  const id = await frame.evaluate(async () => {
    const c = widget.chart(0);
    return c.createShape(
      { time: c.getVisibleRange().to - 3600, price: 0.565 },
      { shape: "horizontal_line" },
    );
  });
  await page.waitForTimeout(1500);
  const added = await frame.evaluate(() =>
    [0, 1].map((i) =>
      widget
        .chart(i)
        .getAllShapes()
        .map((s) => ({
          name: s.name,
          points: widget.chart(i).getShapeById(s.id).getPoints(),
        })),
    ),
  );
  console.log("ADDED", JSON.stringify(added));
  require("node:assert/strict").equal(added[1].length, 1);
  await frame.evaluate(
    (id) =>
      widget
        .chart(0)
        .getShapeById(id)
        .setPoints([
          { price: 0.567, time: widget.chart(0).getVisibleRange().to - 3600 },
        ]),
    id,
  );
  await page.waitForTimeout(1000);
  const changed = await frame.evaluate(() => {
    const c = widget.chart(1);
    return c.getShapeById(c.getAllShapes()[0].id).getPoints()[0].price;
  });
  require("node:assert/strict").equal(changed, 0.567);
  await frame.evaluate(async () => {
    await widget.chart(1).setSymbol("XAUUSD", { doNotActivateChart: true });
  });
  await page.waitForTimeout(1000);
  require("node:assert/strict").equal(
    await frame.evaluate(() => widget.chart(1).getAllShapes().length),
    0,
    "A different symbol must not receive NZDUSD drawings",
  );
  await frame.evaluate(async () => {
    await widget
      .chart(1)
      .setSymbol("OANDA:NZD_USD", { doNotActivateChart: true });
  });
  await page.waitForTimeout(1000);
  require("node:assert/strict").equal(
    await frame.evaluate(() => {
      const c = widget.chart(1);
      return c.getShapeById(c.getAllShapes()[0].id).getPoints()[0].price;
    }),
    0.567,
    "Returning to the symbol must restore its shared drawing",
  );
  await frame.evaluate((id) => widget.chart(0).removeEntity(id), id);
  await page.waitForTimeout(1000);
  require("node:assert/strict").equal(
    await frame.evaluate(() => widget.chart(1).getAllShapes().length),
    0,
  );
  await frame.evaluate(async () => {
    const c = widget.chart(0);
    await c.createShape(
      { time: c.getVisibleRange().to - 3600, price: 0.569 },
      { shape: "horizontal_line" },
    );
    await new Promise((ok, fail) => widget.saveChartToServer(ok, fail));
  });
  const originalId = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  const original = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/advanced-charts/native-charts")).json()).find(
        (row) => row.id === id,
      ),
    originalId,
  );
  const ui = page.frames().find((f) => f.url().startsWith("blob:"));
  page.once("dialog", (dialog) => dialog.accept("画线隔离验收 B"));
  await ui
    .getByRole("button", {
      name: "保存当前工作区并新建空白工作区",
      exact: true,
    })
    .click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector("iframe[data-workspace-id]")
        ?.getAttribute("data-workspace-id") !== id,
    originalId,
  );
  await page.waitForTimeout(1000);
  frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await frame.waitForFunction(() => ready && !loading, null, {
    timeout: 60000,
  });
  await frame.evaluate(async () => widget.chart(0).setSymbol("OANDA:NZD_USD"));
  require("node:assert/strict").equal(
    await frame.evaluate(() => widget.chart(0).getAllShapes().length),
    0,
    "Fresh workspace must not inherit same-symbol drawings",
  );
  await frame.evaluate(
    async (row) =>
      widget.loadChartFromServer({
        id: row.id,
        name: row.name,
        image_url: "",
        modified_iso: row.timestamp,
        short_symbol: row.symbol,
        interval: row.resolution,
      }),
    original,
  );
  await frame.waitForFunction(
    () => !loading && widget.chartsCount() === 2,
    null,
    { timeout: 60000 },
  );
  const restoredPrices = await frame.evaluate(() =>
    [0, 1].map((i) => {
      const c = widget.chart(i);
      return c
        .getAllShapes()
        .map((shape) => c.getShapeById(shape.id).getPoints()[0].price);
    }),
  );
  require("node:assert/strict").deepEqual(
    restoredPrices,
    [[0.569], [0.569]],
    "Original workspace drawings must survive another workspace using the same symbol",
  );
  console.log("DRAWING_SYNC_PASSED");
  console.log(
    "status",
    await page.locator("[role=status]").textContent(),
    "error",
    await page.locator("[role=alert]").allTextContents(),
  );
  console.log(
    "chart",
    await frame.evaluate(() => ({
      ready,
      count: widget.chartsCount(),
      symbol: widget.chart(0).symbol(),
      range: widget.chart(0).getVisibleRange(),
    })),
  );
  await page.screenshot({ path: "/tmp/mw-demand.png" });
  console.log({ errors });
  require("node:assert/strict").deepEqual(errors, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
