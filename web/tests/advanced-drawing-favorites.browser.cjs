// Native drawing favorites → server settings → another workspace after reload.
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
  const group = ui.locator('[data-name="linetool-group-trend-line"]');
  await group.hover();
  await group.locator("button").last().click();
  const label = "水平线";
  const row = ui
    .getByText(label, { exact: true })
    .locator(
      'xpath=ancestor::*[.//button[@data-qa-id="preset-menu-favorite-button"]][1]',
    );
  const star = row.locator('[data-qa-id="preset-menu-favorite-button"]');
  const before = await star.getAttribute("aria-label");
  const initial = await page.evaluate(async () =>
    (await (await fetch("/api/advanced-charts/preferences")).json()).filter(
      (r) => r.kind === "setting",
    ),
  );
  await row.hover();
  await star.click();
  const after = await star.getAttribute("aria-label");
  assert.notEqual(after, before);
  let changed = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const settings = await page.evaluate(async () =>
      (await (await fetch("/api/advanced-charts/preferences")).json()).filter(
        (r) => r.kind === "setting",
      ),
    );
    changed = settings.filter(
      (r) =>
        /favor|drawing/i.test(r.name) &&
        !initial.some(
          (old) =>
            old.name === r.name &&
            JSON.stringify(old.content) === JSON.stringify(r.content),
        ),
    );
    if (changed.length) break;
    await page.waitForTimeout(500);
  }
  assert.ok(changed.length, "Native favorite must persist via server settings");
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "绘图收藏跨工作区验收" }),
    });
    if (!response.ok) throw Error("create workspace " + response.status);
  });
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
  assert.notEqual(
    await page
      .locator("iframe[data-workspace-id]")
      .getAttribute("data-workspace-id"),
    originalWorkspace,
  );
  const ru = restored.childFrames()[0];
  const restoredGroup = ru.locator('[data-name="linetool-group-trend-line"]');
  await restoredGroup.hover();
  await restoredGroup.locator("button").last().click();
  const labelNode = ru.getByText(label, { exact: true });
  const restoredStar = labelNode
    .locator(
      'xpath=ancestor::*[.//button[@data-qa-id="preset-menu-favorite-button"]][1]',
    )
    .locator('[data-qa-id="preset-menu-favorite-button"]');
  assert.equal(await restoredStar.getAttribute("aria-label"), after);
  await labelNode.hover();
  await restoredStar.click();
  assert.equal(await restoredStar.getAttribute("aria-label"), before);
  assert.deepEqual(errors, []);
  console.log("DRAWING_FAVORITE_PERSISTED", {
    label,
    before,
    after,
    keys: changed.map((r) => r.name),
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
