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
    viewport: { width: 915, height: 412 },
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
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
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
  await page.screenshot({ path: "/tmp/mw-demand.png" });
  console.log({ errors });
  require("node:assert/strict").deepEqual(errors, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
