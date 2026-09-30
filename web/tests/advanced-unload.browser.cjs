// Pending native save protects navigation; completed save permits HTTPS reload.
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
    ignoreHTTPSErrors: true,
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
  await page.route(/\/api\/(market-data\/history|charts\/data)$/, (route) => {
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
          symbol: "XAUUSD",
          interval: "240",
        },
      });
      const catalog = await (
        await fetch("/api/market-data/catalog?query=NZD_USD")
      ).json();
      return catalog;
    }),
  );
  await page.goto("https://localhost:15443/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  await page.waitForTimeout(1000);
  const assert = require("node:assert/strict");
  await page.mouse.click(10, 10);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let intercepted;
  const pendingSave = new Promise((resolve) => {
    intercepted = resolve;
  });
  await page.route(
    "**/api/advanced-charts/native-charts/save",
    async (route) => {
      intercepted();
      await gate;
      await route.continue();
    },
  );
  await frame.waitForFunction(
    () => ready && !loading && !nativeSaving && !rangeGuard?.busy(),
    null,
    { timeout: 60000 },
  );
  await frame.evaluate(() => snapshot());
  await pendingSave;
  const dialogPromise = page.waitForEvent("dialog");
  const navigation = page.reload({ timeout: 3000 }).catch(() => {});
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), "beforeunload");
  await dialog.dismiss();
  release();
  // A dismissed reload may wait for its navigation timeout in Playwright.
  // Do not hold the server save behind that unrelated wait.
  await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
  await navigation;
  let unexpectedDialog = false;
  page.on("dialog", async (d) => {
    unexpectedDialog = true;
    await d.dismiss();
  });
  await page.reload();
  assert.equal(unexpectedDialog, false);
  let historyRequests = 0;
  page.on("request", (r) => {
    if (/\/api\/(charts\/data|market-data\/history)$/.test(r.url()))
      historyRequests++;
  });
  await page.goto("https://localhost:15443/");
  const afterExit = historyRequests;
  await page.waitForTimeout(17000);
  assert.equal(
    historyRequests,
    afterExit,
    "Chart history polling must stop after leaving module",
  );
  assert.deepEqual(errors, []);
  console.log(
    "UNLOAD_GUARD_PASSED: pending save prompts; successful save permits reload",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
