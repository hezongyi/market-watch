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
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  const deletedId = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  await page.route("**/api/advanced-charts/workspaces", async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    else await route.continue();
  });
  await frame.evaluate((id) => {
    widget.removeChartFromServer(id, () => {});
  }, deletedId);
  await page.getByRole("heading", { name: "专业图表夹" }).waitFor();
  assert.equal(await page.locator('iframe[title="专业图表工作区"]').count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "新建工作区", exact: true })
      .isEnabled(),
    true,
  );
  await page.unroute("**/api/advanced-charts/workspaces");
  page.once("dialog", (dialog) => dialog.accept("空状态恢复验收"));
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  await page.locator('iframe[title="专业图表工作区"]').waitFor();
  await page.waitForFunction(
    () => document.querySelector("iframe[data-workspace-id]")?.dataset.workspaceId,
  );
  const id = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  assert.notEqual(id, deletedId);
  const rows = await page.evaluate(
    async () => await (await fetch("/api/advanced-charts/workspaces")).json(),
  );
  assert.ok(rows.some((r) => r.id === id && r.name === "空状态恢复验收"));
  assert.equal(
    rows.some((r) => r.id === deletedId),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Empty list after active deletion shows creation entry; creating a new workspace persists a distinct ID",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
