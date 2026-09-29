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
      ? { width: 412, height: 915 } : { width: 915, height: 412 },
    isMobile: true,
    hasTouch: true,
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
    if (r.status() >= 400) console.log("HTTP_FAILURE", r.status(), new URL(r.url()).pathname);
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
  const loginResponse = page.waitForResponse(r => r.url().endsWith("/api/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "登录工作台" }).click();
  require("node:assert/strict").equal((await loginResponse).status(), 200);
  await page.waitForFunction(async () => (await fetch("/api/session")).ok);
  const draftId = await page.evaluate(async () => {
    const rows = await (await fetch("/api/advanced-charts/workspaces")).json();
    localStorage.setItem("mw-tv-draft:" + rows[0].id, "preserve-desktop-draft");
    return rows[0].id;
  });
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
  if (!frame) {
    console.log("MOBILE_FAILED_PAGE", page.url(), await page.locator("body").innerText());
    await page.screenshot({path:"/tmp/mw-mobile-login-failure.png"});
    throw Error("Chart iframe did not initialize");
  }
  await frame.evaluate(
    () =>
      new Promise((resolve) => widget.chart(0).setResolution("15", resolve)),
  );
  await page.waitForTimeout(5000);
  await frame.evaluate(async () => {
    const c = widget.chart(0),
      r = c.getVisibleRange();
    await c.setVisibleRange({ from: r.from - 3600, to: r.to - 3600 });
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
      symbol: widget.chart(0).symbol(),
      range: widget.chart(0).getVisibleRange(),
    })),
  );
  await page.screenshot({ path: process.env.MARKET_WATCH_PORTRAIT ? "/tmp/mw-mobile-portrait.png" : "/tmp/mw-mobile-landscape.png" });
  console.log({ errors });
  require("node:assert/strict").deepEqual(errors, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
