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
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname !== "/api/market-data/history")
        return;
      try {
        const q = response.request().postDataJSON(),
          value = await response.json();
        responses.push({ q, value });
      } catch {
        /* response may be cancelled when leaving the page */
      }
    });
    const base = process.env.MARKET_WATCH_TEST_URL || "http://127.0.0.1:5189";
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
    await page.goto(base + "/advanced-charts");
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
    await frame
      .waitForFunction(
        () =>
          widget.chart(0).resolution() === "1M" && widget.chart(0).dataReady(),
        null,
        { timeout: 60000 },
      )
      .catch(async (error) => {
        console.log(
          "MONTHLY_WAIT_STATE",
          JSON.stringify(
            await frame.evaluate(() => ({
              resolution: widget.chart(0).resolution(),
              dataReady: widget.chart(0).dataReady(),
              range: widget.chart(0).getVisibleRange(),
              loading,
              ready,
              guard: rangeGuard?.busy(),
            })),
          ),
        );
        console.log(
          "HISTORY_TRACE",
          JSON.stringify(
            responses.map(({ q, value }) => ({
              q,
              status: value.status,
              local: value.local_only,
              bars: value.bars?.length,
            })),
          ),
        );
        console.log("PAGE_ERRORS", JSON.stringify(errors));
        throw error;
      });
    const after = await frame.evaluate(() => ({
      epoch: workspaceEpoch,
      resolution: widget.chart(0).resolution(),
      range: widget.chart(0).getVisibleRange(),
      shapes: widget.chart(0).getAllShapes().length,
    }));
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.shapes, 1);
    assert.ok(after.range.to > after.range.from);
    assert.ok(responses.some((r) => r.q.timeframe === "MN"));
    for (const { q, value } of responses) {
      if (q.timeframe !== "MN") continue;
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
