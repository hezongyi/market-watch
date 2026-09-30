// Local container HTTPS acceptance. Self-signed certificate is limited to this test.
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
  const errors = [],
    leaked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    if (request.url().startsWith("https://127.0.0.1:15444/")) {
      const headers = request.headers();
      if (headers.authorization || headers.cookie)
        leaked.push(new URL(request.url()).pathname);
    }
  });
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
  const nativeUI = frame.childFrames()[0];
  await nativeUI
    .getByRole("button", { name: "图表功能与替代入口说明", exact: true })
    .click();
  await nativeUI.getByText("图表功能说明", { exact: true }).waitFor();
  const help = await nativeUI.locator("body").innerText();
  assert.ok(help.includes("不包含原生内置指标值"));
  assert.ok(help.includes("原生模板菜单的“保存为…”暂不可用"));
  await nativeUI.getByRole("button", { name: "确认", exact: true }).click();
  await frame.evaluate(() => widget.activeChart().setResolution("15"));
  await frame.waitForFunction(
    () =>
      widget.activeChart().resolution() === "15" &&
      widget.activeChart().dataReady(),
  );
  await page.waitForTimeout(2000);
  await frame.waitForFunction(() => !nativeSaving && !rangeGuard?.busy());
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(leaked, []);
  await page.screenshot({ path: "/tmp/mw-container-https.png" });
  console.log("CONTAINER_HTTPS_PASSED", {
    origin: new URL(frame.url()).origin,
    errors,
    credentialsSentToChart: leaked.length,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
