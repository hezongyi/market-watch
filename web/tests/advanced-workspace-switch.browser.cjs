// Development acceptance: creates two workspaces and exercises native load/save with real API.
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
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
  const activeId = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  const result = await frame.evaluate(async (activeId) => {
    const settle = async () => {
      for (
        let i = 0;
        i < 1500 && (loading || nativeSaving || rangeGuard?.busy());
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (loading || nativeSaving || rangeGuard?.busy())
        throw Error("Workspace did not finish loading");
    };
    await settle();
    const save = async () => {
      await settle();
      return new Promise((ok, fail) =>
        widget.saveChartToServer(ok, (error) =>
          fail(Error(JSON.stringify(error))),
        ),
      );
    };
    const scaleA = widget.chart(0).getTimeScale();
    scaleA.setRightOffset(4);
    for (let i = 0; i < 50 && scaleA.rightOffset() !== 4; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (scaleA.rightOffset() !== 4) throw Error("A margin did not settle");
    await save();
    const rangeA = widget.chart(0).getVisibleRange();
    const all = await request({ op: "list", args: {} }, "workspace");
    const a = all.find((row) => row.id === activeId);
    if (!a) throw Error("Active native layout is absent from workspace list");
    const content = await request(
      { op: "load", args: { id: a.id } },
      "workspace",
    );
    const b = await request(
      {
        op: "save",
        args: {
          name: "原生切换验收 B",
          symbol: a.symbol,
          resolution: a.resolution,
          content: content.content,
          revision: 0,
        },
      },
      "workspace",
    );
    await widget.loadChartFromServer({
      id: b.id,
      name: b.name,
      image_url: "",
      modified_iso: b.timestamp,
      short_symbol: b.symbol,
      interval: b.resolution,
    });
    await settle();
    const bLoadedRange = widget.chart(0).getVisibleRange();
    const scaleB = widget.chart(0).getTimeScale();
    scaleB.setRightOffset(14);
    for (let i = 0; i < 50 && scaleB.rightOffset() !== 14; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (scaleB.rightOffset() !== 14) throw Error("B margin did not settle");
    await save();
    const rangeB = widget.chart(0).getVisibleRange();
    const bAfter = await request(
      { op: "load", args: { id: b.id } },
      "workspace",
    );
    await widget.loadChartFromServer({
      id: a.id,
      name: a.name,
      image_url: "",
      modified_iso: a.timestamp,
      short_symbol: a.symbol,
      interval: a.resolution,
    });
    await settle();
    const aLoadedRange = widget.chart(0).getVisibleRange();
    await save();
    const aAfter = await request(
      { op: "load", args: { id: a.id } },
      "workspace",
    );
    return {
      rangeA,
      rangeB,
      bLoadedRange,
      aLoadedRange,
      a: a.id,
      b: b.id,
      bRevBefore: b.revision,
      bRevAfter: bAfter.revision,
      aRevBefore: a.revision,
      aRevAfter: aAfter.revision,
      name: widget.layoutName(),
    };
  }, activeId);
  console.log("SWITCH", result);
  const assert = require("node:assert/strict");
  assert.notEqual(result.a, result.b);
  assert.deepEqual(
    result.bLoadedRange,
    result.rangeA,
    "Copied workspace must restore original viewport",
  );
  assert.notDeepEqual(
    result.rangeA,
    result.rangeB,
    "Fixtures must have distinct viewports",
  );
  assert.deepEqual(
    result.aLoadedRange,
    result.rangeA,
    "Switching back must restore A rather than retain B viewport",
  );
  assert.equal(
    await page
      .locator("iframe[data-workspace-id]")
      .getAttribute("data-workspace-id"),
    result.a,
  );
  assert.equal(
    frame.isDetached(),
    false,
    "native switching must keep the iframe alive",
  );
  assert.ok(result.bRevAfter > result.bRevBefore);
  assert.ok(result.aRevAfter > result.aRevBefore);
  await frame.evaluate(
    async (result) =>
      request(
        { op: "delete", args: { id: result.b, revision: result.bRevAfter } },
        "workspace",
      ),
    result,
  );
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await (await fetch("/api/advanced-charts/workspaces")).json()).some(
          (row) => row.id === id,
        ),
      result.b,
    ),
    false,
  );
  assert.equal(
    await page
      .locator("iframe[data-workspace-id]")
      .getAttribute("data-workspace-id"),
    result.a,
  );

  await frame.waitForFunction(
    () => widget.chart(0).getVisibleRange().from > 0,
    {},
    { timeout: 20000 },
  );
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
  assert.deepEqual(errors, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
