// Real development API: monthly cache-only rendering, rapid switching and drawings.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 950 },
    });
    const errors = [],
      responses = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      url.port = "8002";
      const response = await route.fetch({ url: url.href }).catch(() => {
        throw Error("Development API request failed");
      });
      if (url.pathname === "/api/market-data/history") {
        const q = route.request().postDataJSON(),
          value = await response.json();
        if (q.timeframe === "MN") responses.push({ q, value });
      }
      await route.fulfill({ response });
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
    await page.waitForTimeout(500);
    await page.evaluate(async () => {
      const session = await (await fetch("/api/session")).json();
      async function post(path, body) {
        const r = await fetch("/api" + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw Error(await r.text());
        return r.json();
      }
      const row = await post("/advanced-charts/workspaces", {
        name: "月线仅本地验收",
      });
      await post("/advanced-charts/workspaces/" + row.id + "/save", {
        name: row.name,
        revision: row.revision,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          symbol: "EURUSD",
          interval: "1M",
        },
      });
    });
    await page.goto("http://127.0.0.1:5188/advanced-charts");
    await page.waitForTimeout(1500);
    const frame = page.frames().find((f) => f.url().includes(":5187/?"));
    assert.ok(frame);
    await frame.waitForFunction(
      () => ready && !loading && widget.chart(0).dataReady(),
      null,
      { timeout: 60000 },
    );
    const before = await frame.evaluate(async () => {
      const c = widget.chart(0);
      await c.createShape(
        { time: c.getVisibleRange().to, price: 1.1 },
        { shape: "horizontal_line" },
      );
      return { epoch: workspaceEpoch, range: c.getVisibleRange() };
    });
    for (const resolution of ["1W", "1M", "1W", "1M"]) {
      await frame.evaluate(
        (r) =>
          widget
            .chart(0)
            .setResolution(r)
            .catch(() => {}),
        resolution,
      );
      await page.waitForTimeout(100);
    }
    await frame.waitForFunction(
      () =>
        widget.chart(0).resolution() === "1M" && widget.chart(0).dataReady(),
      null,
      { timeout: 60000 },
    );
    const after = await frame.evaluate(() => ({
      epoch: workspaceEpoch,
      resolution: widget.chart(0).resolution(),
      range: widget.chart(0).getVisibleRange(),
      shapes: widget.chart(0).getAllShapes().length,
    }));
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.shapes, 1);
    assert.ok(after.range.to > after.range.from);
    assert.ok(responses.length);
    for (const { value } of responses) {
      assert.equal(value.local_only, true);
      assert.deepEqual(value.task_ids, []);
    }
    assert.deepEqual(errors, []);
    console.log(
      "MONTHLY_LOCAL_REAL",
      JSON.stringify({ monthlyRequests: responses.length, after, errors }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
