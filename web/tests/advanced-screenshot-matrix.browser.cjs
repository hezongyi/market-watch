// Native PNG downloads for four/eight charts in both themes.
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
  const originalTheme = await frame.evaluate(() => widget.getTheme());
  const results = [];
  for (const layout of ["4", "8"]) {
    await frame.evaluate((layout) => widget.setLayout(layout), layout);
    await frame.waitForFunction(
      (layout) =>
        widget.layout() === layout &&
        Array.from({ length: widget.chartsCount() }, (_, i) =>
          widget.chart(i),
        ).every((c) => c.dataReady() && c.getTimeScale().width() > 0),
      layout,
      { timeout: 60000 },
    );
    assert.equal(
      await frame.evaluate(() => widget.chartsCount()),
      Number(layout),
    );
    for (const theme of ["Light", "Dark"]) {
      await frame.evaluate((theme) => widget.changeTheme(theme), theme);
      assert.equal(await frame.evaluate(() => widget.getTheme()), theme.toLowerCase());
      await page.waitForTimeout(500);
      await ui.getByRole("button", { name: "生成快照", exact: true }).click();
      const downloading = page.waitForEvent("download", { timeout: 15000 });
      await ui.getByText("下载图片", { exact: true }).click();
      const download = await downloading;
      const path = `/tmp/mw-native-${layout}-${theme.toLowerCase()}.png`;
      await download.saveAs(path);
      const png = fs.readFileSync(path);
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      const width = png.readUInt32BE(16),
        height = png.readUInt32BE(20);
      assert.ok(
        width > 1000 && height > 600,
        "Download must include chart workspace",
      );
      results.push({ layout, theme, path, width, height, bytes: png.length });
    }
  }
  await frame.evaluate((theme) => widget.changeTheme(theme), originalTheme);
  assert.deepEqual(errors, []);
  console.log("NATIVE_SCREENSHOT_MATRIX", { results, errors });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
