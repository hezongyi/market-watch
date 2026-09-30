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
    if (m.type() === "error" || m.text().startsWith("MOBILE_LOAD_FORMAT"))
      console.log("CONSOLE", m.text().slice(0, 1200));
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
  await page.waitForFunction(async () => (await fetch("/api/session")).ok);
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
  const preferencesBefore = await page.evaluate(async () =>
    (await fetch("/api/advanced-charts/preferences")).json(),
  );
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
  const frame = page
    .frames()
    .find((f) =>
      f
        .url()
        .startsWith(
          process.env.MARKET_WATCH_CHART_ORIGIN || "http://127.0.0.1:5187/",
        ),
    );
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
  // Reload through the native workspace adapter, exercising its chart_loaded
  // lifecycle as well as the initial saved_data path.
  await frame.evaluate(async (id) => {
    const rows = await new Promise((resolve) => widget.getSavedCharts(resolve));
    const row = rows.find((row) => String(row.id) === id);
    if (!row) throw Error("Saved workspace absent from native list");
    const other = rows.find(
      (candidate) =>
        String(candidate.id) !== id &&
        ["1", "5", "15", "30", "60", "240"].includes(candidate.interval),
    );
    if (!other)
      throw Error("Second intraday workspace required for switch acceptance");
    for (const candidate of [row, other]) {
      const loaded = await request(
        { op: "load", args: { id: String(candidate.id) } },
        "workspace",
      );
      const state = JSON.parse(loaded.content);
      console.log(
        "MOBILE_LOAD_FORMAT",
        JSON.stringify({
          id: candidate.id,
          name: candidate.name,
          keys: Object.keys(state),
          contentType: typeof state.content,
          charts: Array.isArray(state.charts),
        }),
      );
    }
    await widget.loadChartFromServer(other);
    const deadline = Date.now() + 60000;
    while (
      loading ||
      widget.chartsCount() !== 1 ||
      !widget.activeChart().dataReady()
    ) {
      if (Date.now() > deadline)
        throw Error("Second workspace did not settle to one chart");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await widget.loadChartFromServer(row);
  }, draftId);
  await frame.waitForFunction(
    () =>
      !loading &&
      widget.chartsCount() === 1 &&
      widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  // Build a memory-only desktop-shaped document with known analysis objects.
  // No fixture is written to the server or to the desktop draft.
  const analysisBefore = await frame.evaluate(async () => {
    const chart = widget.activeChart();
    await chart.createStudy("Moving Average", false, false);
    await chart.createShape(
      { time: chart.getVisibleRange().to - 3600, price: 1.1 },
      { shape: "horizontal_line" },
    );
    await chart.createMultipointShape(
      [
        { time: 1790323200, price: 1.09 },
        { time: 1790337600, price: 1.11 },
      ],
      { shape: "trend_line" },
    );
    const expected = {
      studies: chart.getAllStudies().map((study) => ({
        ...study,
        inputs: chart.getStudyById(study.id).getInputValues(),
      })),
      shapes: chart.getAllShapes().map((shape) => ({
        ...shape,
        points: chart
          .getShapeById(shape.id)
          .getPoints()
          .map((point) =>
            shape.name === "horizontal_line" ? { price: point.price } : point,
          ),
      })),
    };
    widget.setLayout("2h");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = await new Promise((resolve) => widget.save(resolve));
    await widget.load(state);
    return expected;
  });
  await frame.waitForFunction(
    () =>
      !loading &&
      widget.chartsCount() === 1 &&
      widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  const analysisAfter = await frame.evaluate(() => ({
    studies: widget
      .activeChart()
      .getAllStudies()
      .map((study) => ({
        ...study,
        inputs: widget.activeChart().getStudyById(study.id).getInputValues(),
      })),
    shapes: widget
      .activeChart()
      .getAllShapes()
      .map((shape) => ({
        ...shape,
        points: widget
          .activeChart()
          .getShapeById(shape.id)
          .getPoints()
          .map((point) =>
            shape.name === "horizontal_line" ? { price: point.price } : point,
          ),
      })),
  }));
  require("node:assert/strict").deepEqual(analysisAfter, analysisBefore);
  console.log("MOBILE_ANALYSIS_PRESERVED", analysisAfter);
  if (process.env.MARKET_WATCH_MOBILE_EVENT_PROBE) {
    await frame.evaluate(() => {
      const chart = widget.activeChart();
      window.mobileEvents = [];
      for (const name of [
        "onIntervalChanged",
        "onDataLoaded",
        "onSymbolChanged",
      ])
        chart[name]().subscribe(null, (...args) =>
          window.mobileEvents.push({
            event: name,
            at: performance.now(),
            args: args.map((x) => (typeof x === "string" ? x : typeof x)),
            resolution: chart.resolution(),
            ready: chart.dataReady(),
          }),
        );
    });
  }
  if (!process.env.MARKET_WATCH_MOBILE_SKIP_PERIOD_PROBE) {
    await frame.evaluate(async () => {
      await widget.activeChart().setResolution("15");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await frame.waitForFunction(
      () =>
        widget.activeChart().resolution() === "15" &&
        widget.activeChart().dataReady() &&
        widget.activeChart().getVisibleRange().from > 0,
      null,
      { timeout: 60000 },
    );
  }
  if (process.env.MARKET_WATCH_MOBILE_SETTLE_PROBE)
    await page.waitForTimeout(2000);
  if (process.env.MARKET_WATCH_MOBILE_RESET_PROBE) {
    await frame.evaluate(() => widget.activeChart().resetData());
    await page.waitForTimeout(3000);
    await frame.waitForFunction(() => widget.activeChart().dataReady(), null, {
      timeout: 30000,
    });
  }
  if (process.env.MARKET_WATCH_MOBILE_EVENT_PROBE)
    console.log(
      "MOBILE_EVENT_TRACE",
      await frame.evaluate(() => window.mobileEvents),
    );
  console.log(
    "MOBILE_BEFORE_RANGE",
    await frame.evaluate(() => ({
      active: widget.activeChart().symbol(),
      sync: widget.dateRangeSync().value(),
      guard: rangeGuard?.busy(),
      panes: Array.from({ length: widget.chartsCount() }, (_, i) => ({
        symbol: widget.chart(i).symbol(),
        res: widget.chart(i).resolution(),
        ready: widget.chart(i).dataReady(),
        range: widget.chart(i).getVisibleRange(),
        width: widget.chart(i).getTimeScale().width(),
        max: widget.chart(i).isMaximized(),
      })),
    })),
  );
  if (process.env.MARKET_WATCH_MOBILE_NO_SYNC_PROBE)
    await frame.evaluate(() => {
      widget.dateRangeSync().setValue(false);
      widget.timeSync().setValue(false);
    });
  await frame.evaluate(async () => {
    const c = widget.activeChart(),
      r = c.getVisibleRange();
    await c.setVisibleRange(
      { from: r.from - 3600, to: r.to - 3600 },
      { rejectByTimeout: 20000 },
    );
    snapshot();
  });
  await page.waitForTimeout(5000);
  require("node:assert/strict").equal(
    await page.evaluate(
      (id) => localStorage.getItem("mw-tv-draft:" + id),
      draftId,
    ),
    "preserve-desktop-draft",
  );
  require("node:assert/strict").equal(
    await page.getByRole("alert").filter({ hasText: "存在未保存草稿" }).count(),
    0,
  );
  const serverAfter = await page.evaluate(async () =>
    (await fetch("/api/advanced-charts/workspaces")).json(),
  );
  require("node:assert/strict").deepEqual(serverAfter, serverBefore);
  const preferencesAfter = await page.evaluate(async () =>
    (await fetch("/api/advanced-charts/preferences")).json(),
  );
  require("node:assert/strict").deepEqual(preferencesAfter, preferencesBefore);
  require("node:assert/strict").equal(
    await frame
      .childFrames()[0]
      .getByRole("button", { name: "保存图表样式模板", exact: true })
      .count(),
    0,
  );
  console.log("MOBILE_WRITES", writes);
  require("node:assert/strict").deepEqual(writes, []);
  console.log("MOBILE_READONLY", await frame.evaluate(() => nativeReadonly));
  require("node:assert/strict").equal(
    await frame.evaluate(() => nativeReadonly),
    true,
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
      symbol: widget.activeChart().symbol(),
      range: widget.activeChart().getVisibleRange(),
    })),
  );
  await page.screenshot({
    path: process.env.MARKET_WATCH_PORTRAIT
      ? "/tmp/mw-mobile-portrait.png"
      : "/tmp/mw-mobile-landscape.png",
  });
  console.log({ errors });
  require("node:assert/strict").deepEqual(errors, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
