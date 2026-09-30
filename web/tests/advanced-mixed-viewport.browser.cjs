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
  // Fixed historical acceptance still reads real backend data. It does not
  // verify live ingestion or cold-history performance.
  const cutoff = Number(process.env.MARKET_WATCH_HISTORY_BEFORE || 0);
  if (cutoff) {
    if (!Number.isSafeInteger(cutoff) || cutoff <= 0)
      throw Error("Invalid historical cutoff");
    await page.route(/\/api\/(market-data\/history|charts\/data)$/, route => {
      const q = route.request().postDataJSON();
      return route.continue({postData: JSON.stringify({
        ...q, before: Math.min(q.before || cutoff, cutoff),
      })});
    });
    console.log("HISTORICAL_ACCEPTANCE_CUTOFF", cutoff);
  }
  const errors = [];
  if (process.env.MARKET_WATCH_RANGE_GUARD_SOURCE)
    await page.route("**/range-sync.js*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: fs.readFileSync(
          process.env.MARKET_WATCH_RANGE_GUARD_SOURCE,
          "utf8",
        ),
      }),
    );
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
  const base = process.env.MARKET_WATCH_TEST_URL || "http://127.0.0.1:5188";
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
        name: "八图历史视区验收",
      });
      await post("/advanced-charts/workspaces/" + row.id + "/save", {
        name: row.name,
        revision: row.revision,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          symbol: "EURUSD",
          interval: "5",
        },
      });
      const catalog = await (
        await fetch("/api/market-data/catalog?query=EURUSD")
      ).json();
      return catalog;
    }),
  );
  await page.goto(base + "/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
  if (process.env.MARKET_WATCH_GOLD_SESSION_PROBE)
    await frame.evaluate(() => {
      const resolve = feed.resolveSymbol;
      feed.resolveSymbol = (ticker, callback, error) =>
        resolve(
          ticker,
          (info) => {
            if (decode(ticker).symbol === "XAUUSD")
              info.session = "1800-1700:23456";
            callback(info);
          },
          error,
        );
    });
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
  await frame.waitForFunction(
    () =>
      !rangeGuard.busy() &&
      Array.from({ length: widget.chartsCount() }, (_, i) =>
        widget.chart(i),
      ).every((chart) => chart.dataReady() && chart.getVisibleRange().from > 0),
    null,
    { timeout: 180000 },
  );
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
  if (process.env.MARKET_WATCH_RANGE_SYNC_ONLY)
    await frame.evaluate(() => widget.timeSync().setValue(false));
  const windowHours = Number(process.env.MARKET_WATCH_VIEWPORT_HOURS || 24);
  assert.ok(Number.isFinite(windowHours) && windowHours > 0);
  const target = await frame.evaluate(
    async ({ windowHours, end }) => {
      const r = widget.chart(0).getVisibleRange();
      const target = {
        from: (end || r.to - 86400) - windowHours * 3600,
        to: end || r.to - 86400,
      };
      await widget.chart(0).setVisibleRange(target, { rejectByTimeout: 20000 });
      return target;
    },
    { windowHours, end: Number(process.env.MARKET_WATCH_VIEWPORT_END || 0) },
  );
  await page.waitForTimeout(5000);
  const moved = await frame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) => ({
      symbol: widget.chart(i).symbol(),
      resolution: widget.chart(i).resolution(),
      range: widget.chart(i).getVisibleRange(),
    })),
  );
  console.log("MOVED_RANGES", JSON.stringify({ target, moved }));
  if (process.env.MARKET_WATCH_EDGE_RANGE_PROBE) {
    console.log("EDGE_DIRECT_RANGES", JSON.stringify(await frame.evaluate(async target => {
      widget.dateRangeSync().setValue(false);
      widget.timeSync().setValue(false);
      const results = [];
      for (let i=0;i<widget.chartsCount();i++) {
        const chart=widget.chart(i);
        await chart.setVisibleRange(target, {rejectByTimeout:20000});
        results.push({symbol:chart.symbol(),resolution:chart.resolution(),
          range:chart.getVisibleRange(),offset:chart.getTimeScale().rightOffset()});
      }
      return results;
    }, target)));
    await browser.close();
    return;
  }

  if (process.env.MARKET_WATCH_GOLD_DIRECT_RANGE_PROBE) {
    const direct = await frame.evaluate(async (target) => {
      widget.dateRangeSync().setValue(false);
      const chart = widget.chart(1);
      await chart.setVisibleRange(target, { rejectByTimeout: 20000 });
      const immediate = chart.getVisibleRange();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const settled = chart.getVisibleRange();
      widget.dateRangeSync().setValue(true);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return {
        immediate,
        range: settled,
        resynchronized: chart.getVisibleRange(),
      };
    }, target);
    console.log("GOLD_DIRECT_RANGE", JSON.stringify(direct));
    assert.deepEqual(
      direct.range,
      moved[1].range,
      "Synchronized gold range must match direct native range setting",
    );
    assert.deepEqual(errors, []);
    await browser.close();
    return;
  }
  // Compare same-symbol panes: different instruments can have different sessions.
  for (const pane of moved) {
    const reference = moved.find((other) => other.symbol === pane.symbol);
    const tolerance = Number(pane.resolution) * 60;
    assert.ok(
      Math.abs(pane.range.from - reference.range.from) <= tolerance,
      `${pane.symbol} ${pane.resolution}: left boundary did not synchronize`,
    );
    assert.ok(
      Math.abs(pane.range.to - target.to) <= tolerance,
      `${pane.symbol} ${pane.resolution}: right boundary did not synchronize`,
    );
  }
  if (process.env.MARKET_WATCH_MOUSE_CHECK === "1") {
    phase = "mouse-crosshair";
    await frame.evaluate(() => {
      window.mouseCrosshairEvents = [];
      for (let i = 0; i < widget.chartsCount(); i++) {
        widget
          .chart(i)
          .crossHairMoved()
          .subscribe(null, (event) => {
            window.mouseCrosshairEvents.push({
              pane: i,
              time: event.time,
              price: event.price,
            });
          });
      }
    });
    const library = frame.childFrames()[0];
    assert.ok(library, "Native chart iframe missing");
    console.log(
      "MOUSE_PANE_DOM",
      await library.locator(".chart-container").count(),
    );
    const pane = library.locator(".chart-container").first();
    const box = await pane.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0);
    const x = box.x + box.width * 0.55,
      y = box.y + box.height * 0.45;
    await page.mouse.move(x, y, { steps: 12 });
    await page.waitForTimeout(1000);
    const crosshair = await frame.evaluate(() => window.mouseCrosshairEvents);
    console.log("MOUSE_CROSSHAIR", crosshair);
    const lastEvents = specs.map((_, i) =>
      crosshair.filter((event) => event.pane === i).at(-1),
    );
    assert.ok(
      lastEvents.every((event) => event && Number.isFinite(event.time)),
      "Every pane must receive mouse crosshair time",
    );
    for (let i = 0; i < lastEvents.length; i++) {
      assert.ok(
        Math.abs(lastEvents[i].time - lastEvents[0].time) <
          Number(specs[i][1]) * 60,
        `Crosshair time must match within the destination candle: pane ${i}`,
      );
    }
    await page.screenshot({ path: "/tmp/mw-mouse-crosshair.png" });
    const beforeZoom = await frame.evaluate(() =>
      Array.from({ length: widget.chartsCount() }, (_, i) =>
        widget.chart(i).getVisibleRange(),
      ),
    );
    await page.mouse.wheel(0, -180);
    await page.waitForTimeout(3000);
    const afterZoom = await frame.evaluate(() =>
      Array.from({ length: widget.chartsCount() }, (_, i) =>
        widget.chart(i).getVisibleRange(),
      ),
    );
    console.log("MOUSE_ZOOM", JSON.stringify({ beforeZoom, afterZoom }));
    assert.notDeepEqual(
      afterZoom[0],
      beforeZoom[0],
      "Mouse wheel did not change visible range",
    );
    for (let i = 0; i < afterZoom.length; i++) {
      const tolerance = Number(specs[i][1]) * 60;
      assert.ok(
        Math.abs(afterZoom[i].from - afterZoom[0].from) <= tolerance,
        `Mouse zoom left boundary pane ${i}`,
      );
      assert.ok(
        Math.abs(afterZoom[i].to - afterZoom[0].to) <= tolerance,
        `Mouse zoom right boundary pane ${i}`,
      );
    }
    phase = "mouse-drag";
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 45, y, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(3000);
    const afterDrag = await frame.evaluate(() =>
      Array.from({ length: widget.chartsCount() }, (_, i) =>
        widget.chart(i).getVisibleRange(),
      ),
    );
    console.log("MOUSE_DRAG", JSON.stringify(afterDrag));
    assert.notDeepEqual(
      afterDrag[0],
      afterZoom[0],
      "Mouse drag did not move visible range",
    );
    for (let i = 0; i < afterDrag.length; i++) {
      const tolerance = Number(specs[i][1]) * 60;
      assert.ok(
        Math.abs(afterDrag[i].from - afterDrag[0].from) <= tolerance,
        `Mouse drag left boundary pane ${i}`,
      );
      assert.ok(
        Math.abs(afterDrag[i].to - afterDrag[0].to) <= tolerance,
        `Mouse drag right boundary pane ${i}`,
      );
    }
    // Restore reference ranges for the disabled-sync assertions below.
    await frame.evaluate(
      async (target) =>
        widget.chart(0).setVisibleRange(target, { rejectByTimeout: 20000 }),
      target,
    );
    await page.waitForTimeout(2000);
  }
  phase = "move-with-sync-disabled";
  await frame.evaluate(async () => {
    widget.dateRangeSync().setValue(false);
    widget.timeSync().setValue(false);
    const r = widget.chart(0).getVisibleRange();
    await widget
      .chart(0)
      .setVisibleRange(
        { from: r.from - 3600, to: r.to - 3600 },
        { rejectByTimeout: 20000 },
      );
  });
  await page.waitForTimeout(2000);
  const unsynced = await frame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) =>
      widget.chart(i).getVisibleRange(),
    ),
  );
  assert.notDeepEqual(unsynced[0], moved[0].range);
  assert.deepEqual(
    unsynced.slice(1),
    moved.slice(1).map((p) => p.range),
  );
  phase = "verify-viewport-autosave";
  const activeId = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  await page.waitForFunction(
    async ({ id, ranges }) => {
      const rows = await (
        await fetch("/api/advanced-charts/workspaces")
      ).json();
      const saved = rows.find((row) => row.id === id)?.document.state
        ?._mwViewports;
      return (
        saved?.length === ranges.length &&
        saved.every(
          (pane, i) =>
            pane.range.from === ranges[i].from &&
            pane.range.to === ranges[i].to,
        )
      );
    },
    { id: activeId, ranges: unsynced },
    { timeout: 20000 },
  );
  phase = "reload-final-viewport";
  await page.reload();
  await page.locator('iframe[title="专业图表工作区"]').waitFor();
  await page.waitForTimeout(1000);
  const restoredFrame = page.frames().find((f) => f.url().includes(":5187/?"));
  await restoredFrame.waitForFunction(() => ready && !loading, null, {
    timeout: 60000,
  });
  const restoredRanges = await restoredFrame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) =>
      widget.chart(i).getVisibleRange(),
    ),
  );
  assert.deepEqual(
    restoredRanges,
    unsynced,
    "Autosaved final mouse/viewport state must survive reload",
  );
  assert.equal(
    await restoredFrame.evaluate(() => widget.dateRangeSync().value()),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Mixed-period viewport movement and disabled synchronization passed",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
