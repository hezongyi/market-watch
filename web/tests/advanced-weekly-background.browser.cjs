const waitForAsync = require("./wait-for-async.cjs");
// Real native UI with injected pending weekly planner response; no persisted fixture.
// Development mobile landscape read-only check; uses latest saved workspace, no workspace creation.
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
    viewport: process.env.MARKET_WATCH_PORTRAIT
      ? { width: 412, height: 915 }
      : { width: 915, height: 412 },
    ignoreHTTPSErrors: process.env.MARKET_WATCH_TEST_SELF_SIGNED === "1",
    isMobile: true,
    hasTouch: true,
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
  if (process.env.MARKET_WATCH_MOBILE_DEBUG_SERIES) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Debugger.enable");
    await cdp.send("Debugger.setPauseOnExceptions", { state: "all" });
    cdp.on("Debugger.paused", async (event) => {
      try {
        const frame = event.callFrames.find(
          (f) => f.functionName === "setVisibleTimeRange",
        );
        if (frame) {
          const result = await cdp.send("Debugger.evaluateOnCallFrame", {
            callFrameId: frame.callFrameId,
            expression:
              "JSON.stringify({session:e,series:t,interval:this._studyEngine.getSeriesInterval(e,t),symbolResolved:!!this._studyEngine.getSeriesSymbolInfo(e,t)})",
            returnByValue: true,
            silent: true,
          });
          console.log("SERIES_EXCEPTION_STATE", result.result.value);
        }
      } finally {
        await cdp.send("Debugger.resume").catch(() => {});
      }
    });
  }
  const errors = [],
    writes = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/advanced-charts/"))
      writes.push(r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 700));
  });
  page.on("response", async (r) => {
    if (r.status() >= 400)
      console.log("HTTP_FAILURE", r.status(), new URL(r.url()).pathname);
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
  const loginResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录工作台" }).click();
  require("node:assert/strict").equal((await loginResponse).status(), 200);
  await waitForAsync(page, async () => (await fetch("/api/session")).ok);
  if (process.env.MARKET_WATCH_MOBILE_EIGHT) {
    // Select an existing real eight-pane workspace without mutating its content.
    await page.route("**/api/advanced-charts/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const rows = await response.json();
      const eight = rows.find(
        (row) => row.document?.state?._mwViewports?.length === 8,
      );
      if (!eight) throw Error("No saved eight-pane workspace available");
      await route.fulfill({
        response,
        json: [eight, ...rows.filter((row) => row.id !== eight.id)],
      });
    });
  }
  const draftId = await page.evaluate(async () => {
    const rows = await (await fetch("/api/advanced-charts/workspaces")).json();
    localStorage.setItem("mw-tv-draft:" + rows[0].id, "preserve-desktop-draft");
    return rows[0].id;
  });
  const serverBefore = await page.evaluate(async () =>
    (await fetch("/api/advanced-charts/workspaces")).json(),
  );
  await page.goto(base + "/advanced-charts");
  await page
    .locator('iframe[title="专业图表工作区"]')
    .waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () =>
      document.querySelector('iframe[title="专业图表工作区"]')?.contentWindow,
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().startsWith(process.env.MARKET_WATCH_CHART_ORIGIN || "http://127.0.0.1:5187/"));
  if (!frame) {
    console.log(
      "MOBILE_FAILED_PAGE",
      page.url(),
      await page.locator("body").innerText(),
      page.frames().map((f) => f.url()),
    );
    await page.screenshot({ path: "/tmp/mw-mobile-login-failure.png" });
    throw Error("Chart iframe did not initialize");
  }
  await frame.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  await frame.waitForFunction(() => widget.chartsCount() === 1, null, {
    timeout: 30000,
  });
  require("node:assert/strict").equal(
    await frame.evaluate(() => widget.chartsCount()),
    1,
  );
  let pendingReplies = 0;
  let injectPending = true;
  await page.route("**/api/market-data/history", async (route) => {
    const body = route.request().postDataJSON();
    if (body.timeframe !== "W1" || !injectPending) return route.fallback();
    pendingReplies++;
    await route.fulfill({
      json: {
        status: "pending",
        queue_class: "background",
        bars: [],
        task_ids: ["browser-pending-fixture"],
        estimated_seconds: null,
      },
    });
  });
  await frame.evaluate(() => widget.activeChart().setResolution("1W"));
  await frame.waitForFunction(
    () => pendingHistory.size > 0 && !rangeGuard?.busy(),
    null,
    { timeout: 30000 },
  );
  require("node:assert/strict").ok(pendingReplies > 0);
  const statusText = await page.locator("[role=status]").textContent();
  require("node:assert/strict").match(statusText, /后台队列/);
  if (process.env.MARKET_WATCH_WEEKLY_COMPLETE) {
    injectPending = false;
    await frame.evaluate(() => tick());
    await frame.waitForFunction(() => pendingHistory.size === 0
      && widget.activeChart().resolution() === "1W"
      && widget.activeChart().dataReady()
      && firstHistory.has("EURUSD|1W"), null, {timeout:180000});
    console.log("WEEKLY_REAL_COMPLETION_RELOADED");
  }
  await frame.evaluate(() => widget.activeChart().setResolution("5"));
  await frame.waitForFunction(
    () =>
      widget.activeChart().resolution() === "5" &&
      widget.activeChart().dataReady() &&
      !rangeGuard?.busy(),
    null,
    { timeout: 60000 },
  );
  await frame.evaluate(async () => {
    await tick();
    if (pendingHistory.size) throw Error("Departed weekly view still polls");
    const chart = widget.activeChart(),
      range = chart.getVisibleRange();
    await chart.setVisibleRange(
      { from: range.from - 3600, to: range.to - 3600 },
      { rejectByTimeout: 20000 },
    );
  });
  require("node:assert/strict").deepEqual(errors, []);
  require("node:assert/strict").deepEqual(writes, []);
  console.log("WEEKLY_PENDING_SWITCH_PASSED", {
    pendingReplies,
    statusText,
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
