// Two-minute warm eight-chart polling and subscription teardown acceptance.
// Requires the local acceptance Compose stack; self-signed TLS is test-only.
const { chromium } = require("playwright");
const fs = require("node:fs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  if (process.env.MARKET_WATCH_CANDIDATE_VIEWPORTS === "1")
    await page.route('**/viewports.js', route => route.fulfill({
      path: '../advanced-host/viewports.js', contentType: 'application/javascript',
    }));
  const errors = [];
  let phase = "initialization";
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("EIGHT_CHART_ERROR", JSON.stringify({phase, message:e.message, stack:e.stack}));
  });
  await page.route(/\/api\/(market-data\/history(?:\/cache)?|charts\/data)$/, (route) => {
    const body = route.request().postDataJSON();
    return route.continue({
      postData: JSON.stringify({
        ...body,
        before: Math.min(body.before || 1790622000000, 1790622000000),
      }),
    });
  });
  await page.goto("https://localhost:15443/");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync("../../market-watch/artifacts/local-credentials.json"),
      ).password,
    );
  const login = page.waitForResponse(
    (r) => r.url().endsWith("/api/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录工作台" }).click();
  assert.equal((await login).status(), 200);
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "容器HTTPS验收" }),
    });
    if (!response.ok)
      throw Error("Workspace creation failed " + response.status);
  });
  await page.goto("https://localhost:15443/advanced-charts");
  await page
    .locator('iframe[title="专业图表工作区"]')
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(15000);
  const frame = page
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  assert.ok(frame, "isolated HTTPS chart frame must load");
  await frame.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  const originalWorkspace = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  const ui = frame.childFrames()[0];
  assert.ok(ui);
  await frame.evaluate(() => widget.setLayout("8"));
  await frame.waitForFunction(
    () =>
      widget.chartsCount() === 8 &&
      Array.from({ length: 8 }, (_, i) => widget.chart(i)).every((c) =>
        c.dataReady(),
      ),
    null,
    { timeout: 60000 },
  );
  const mixed = process.env.MARKET_WATCH_MIXED_SOAK === "1";
  if (mixed) {
    phase = "mixed-symbols-and-studies";
    await frame.evaluate(async () => {
      widget.symbolSync().setValue(false);
      const symbols = ["XAUUSD", "EURUSD", "BTCUSDT"];
      for (let i = 0; i < 8; i++) {
        const c = widget.chart(i);
        await new Promise((ok) => c.setSymbol(symbols[i % 3], ok));
        await c.createStudy("Moving Average", false, false, { length: 21 });
      }
    });
    await frame.waitForFunction(
      () =>
        Array.from({ length: 8 }, (_, i) => widget.chart(i)).every(
          (c) => c.dataReady() && c.getAllStudies().length === 1,
        ),
      null,
      { timeout: 90000 },
    );
  }
  let latestRequests = 0;
  page.on("request", (r) => {
    if (
      /\/api\/charts\/data$/.test(r.url()) &&
      r.method() === "POST" &&
      r.postDataJSON()?.limit === 3
    )
      latestRequests++;
  });
  const samples = [];
  phase = "polling-soak";
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(15000);
    const sample = await frame.evaluate(() => ({
      charts: widget.chartsCount(),
      subscriptions: subscriptions.size,
      groups: new Set(
        [...subscriptions.values()].map((s) => s.symbol + "|" + s.res),
      ).size,
      pending: pending.size,
      pendingHistory: pendingHistory.size,
      heap: performance.memory?.usedJSHeapSize ?? null,
    }));
    sample.latestRequests = latestRequests;
    samples.push(sample);
    assert.equal(sample.charts, 8);
    assert.equal(
      sample.groups,
      mixed ? 3 : 1,
      "Same symbol/resolution must share a polling group",
    );
    assert.ok(sample.subscriptions <= 8);
    assert.ok(sample.pending <= 12, "RPC backlog must stay bounded");
    assert.equal(
      sample.pendingHistory,
      0,
      "Warm H4 must not leave background history demands",
    );
    console.log("EIGHT_CHART_SAMPLE", sample);
  }
  assert.ok(
    latestRequests >= (mixed ? 12 : 4) && latestRequests <= (mixed ? 36 : 12),
    "Two minutes must poll once per group, not eight times per interval: " +
      latestRequests,
  );
  if (samples.every((s) => s.heap !== null))
    assert.ok(
      samples.at(-1).heap - samples[0].heap < 64 * 1024 * 1024,
      "Chart-frame JS heap must not grow more than 64 MiB during the sample",
    );
  // Control the timer and expire the one-second request cache before counting network calls.
  await frame.evaluate(() => clearInterval(poll));
  await frame.waitForFunction(() => !polling);
  await page.waitForTimeout(1100);
  phase = "collapse";
  await frame.evaluate(() => widget.setLayout("s"));
  await frame.waitForFunction(() => widget.chartsCount() === 1);
  await frame.waitForFunction(() => !polling);
  const singleStart = latestRequests;
  await frame.evaluate(() => tick());
  assert.equal(latestRequests - singleStart, 1,
    "Hidden subscriptions must not issue extra queries");
  phase = "expand";
  await frame.evaluate(() => widget.setLayout("8"));
  await frame.waitForFunction(() => widget.chartsCount() === 8);
  await frame.waitForFunction(() => !polling);
  await frame.evaluate(() => tick());
  await frame.waitForFunction(() => Array.from({length:8},(_,i)=>widget.chart(i))
    .every(c=>c.dataReady()),null,{timeout:60000});
  await frame.waitForFunction(() => !polling);
  await page.waitForTimeout(1100);
  const expandedStart = latestRequests;
  await frame.evaluate(() => tick());
  assert.equal(latestRequests-expandedStart,mixed ? 3 : 1,
    "Expanded panes must resume visible polling groups");
  assert.deepEqual(errors, []);
  console.log("EIGHT_CHART_POLLING_BOUNDED", {
    samples,
    latestRequests,
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
