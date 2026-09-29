// Development native fullscreen permissions regression.
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
          symbol: "OANDA:NZD_USD",
          interval: "5",
        },
      });
      const catalog = await (
        await fetch("/api/market-data/catalog?query=NZD_USD")
      ).json();
      return catalog;
    }),
  );
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
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
  console.log(
    "UNLOAD_GUARD_PASSED: pending save prompts; successful save permits reload",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
