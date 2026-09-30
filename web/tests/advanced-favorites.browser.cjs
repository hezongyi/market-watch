// Native study template UI → real development API → different workspace → reload.
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
  const errors = [];
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
  await ui
    .locator("#header-toolbar-intervals button[aria-haspopup=menu]")
    .click();
  const item = ui.getByText("15 分钟", { exact: true });
  await item.hover();
  const button = item
    .locator("..")
    .locator("..")
    .locator('[data-qa-id="preset-menu-favorite-button"]');
  const before = await button.getAttribute("aria-label");
  await button.click();
  const after = await button.getAttribute("aria-label");
  assert.notEqual(after, before);
  await page.waitForTimeout(1500);
  const stored = await page.evaluate(async () =>
    (await (await fetch("/api/advanced-charts/preferences")).json()).filter(
      (r) => r.kind === "setting" && /favorite|interval/i.test(r.name),
    ),
  );
  assert.ok(stored.length > 0);
  await page.reload();
  await page.waitForTimeout(15000);
  const restored = page
    .frames()
    .find((f) => f.url().startsWith("https://127.0.0.1:15444/"));
  await restored.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
    null,
    { timeout: 60000 },
  );
  const ru = restored.childFrames()[0];
  await ru
    .locator("#header-toolbar-intervals button[aria-haspopup=menu]")
    .click();
  const rb = ru
    .locator('[data-value="15"]')
    .locator('[data-qa-id="preset-menu-favorite-button"]');
  assert.equal(await rb.getAttribute("aria-label"), after);
  await rb.click();
  assert.equal(await rb.getAttribute("aria-label"), before);
  assert.deepEqual(errors, []);
  console.log("PERIOD_FAVORITES_PERSISTED", {
    before,
    after,
    keys: stored.map((r) => r.name),
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
