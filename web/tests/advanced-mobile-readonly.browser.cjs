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
  await page.waitForFunction(async () => (await fetch("/api/session")).ok);
  if (process.env.MARKET_WATCH_MOBILE_EIGHT) {
    // Select an existing real eight-pane workspace without mutating its content.
    await page.route("**/api/advanced-charts/workspaces", async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response=await route.fetch();
      const rows=await response.json();
      const eight=rows.find(row=>row.document?.state?._mwViewports?.length===8);
      if (!eight) throw Error("No saved eight-pane workspace available");
      await route.fulfill({response,json:[eight,...rows.filter(row=>row.id!==eight.id)]});
    });
  }
  const draftId = await page.evaluate(async () => {
    const rows = await (await fetch("/api/advanced-charts/workspaces")).json();
    localStorage.setItem("mw-tv-draft:" + rows[0].id, "preserve-desktop-draft");
    return rows[0].id;
  });
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
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
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
  await frame.waitForFunction(() => ready && !loading && widget.activeChart().dataReady(),
    null, {timeout:60000});
  if (process.env.MARKET_WATCH_MOBILE_EIGHT) {
    require("node:assert/strict").equal(await frame.evaluate(()=>widget.chartsCount()),8);
    await frame.evaluate(()=>widget.activeChart().maximizeChart());
    await frame.waitForFunction(()=>widget.activeChart().isMaximized());
    await page.screenshot({path:"/tmp/mw-mobile-eight-maximized.png"});
    await frame.evaluate(()=>widget.activeChart().restoreChart());
    await frame.waitForFunction(()=>!widget.activeChart().isMaximized());
    await frame.evaluate(()=>widget.activeChart().maximizeChart());
  }
  await frame.evaluate(() => widget.activeChart().setResolution("15"));
  await frame.waitForFunction(() => widget.activeChart().resolution() === "15"
    && widget.activeChart().dataReady() && widget.activeChart().getVisibleRange().from > 0,
    null, {timeout:60000});
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
