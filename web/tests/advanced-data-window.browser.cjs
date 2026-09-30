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
  const history = new Map(),
    responses = [];
  page.on("response", (response) => {
    if (!/\/api\/(market-data\/history|charts\/data)$/.test(response.url()))
      return;
    responses.push(
      response
        .json()
        .then((data) => {
          for (const bar of data.bars || [])
            history.set(Number(bar.start), bar);
        })
        .catch(() => {}),
    );
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
  await frame.evaluate(() => {
    widget.activeChart().setChartType(1);
    window.selectedBarTime = null;
    widget
      .activeChart()
      .crossHairMoved()
      .subscribe(null, (e) => (window.selectedBarTime = e.time));
  });
  await frame.waitForFunction(() => widget.activeChart().dataReady());
  const button = ui.getByRole("button", { name: /数据窗口/ });
  if ((await button.getAttribute("aria-pressed")) !== "true")
    await button.click();
  const box = await ui.locator(".chart-container").first().boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, {
    steps: 12,
  });
  await page.waitForTimeout(1000);
  const body = await ui.locator("body").innerText();
  for (const label of ["开盘价", "最高价", "最低价", "收盘价"])
    assert.ok(body.includes(label), label);
  const selected = await frame.evaluate(() => window.selectedBarTime);
  assert.ok(selected > 0);
  await Promise.all(responses);
  const bar = history.get(selected * 1000);
  assert.ok(
    bar,
    "Selected crosshair candle must exist in actual backend responses",
  );
  const lines = body.split("\n").map((s) => s.trim());
  for (const [label, field] of [
    ["开盘价", "open"],
    ["最高价", "high"],
    ["最低价", "low"],
    ["收盘价", "close"],
  ]) {
    const index = lines.lastIndexOf(label);
    const actual = Number(
      lines[index + 1].replaceAll(",", "").replaceAll("−", "-"),
    );
    assert.equal(actual, Number(Number(bar[field]).toFixed(2)), label);
  }
  for (const timezone of ["Etc/UTC", "Asia/Singapore", "America/New_York"]) {
    await frame.evaluate(
      (zone) => widget.activeChart().getTimezoneApi().setTimezone(zone),
      timezone,
    );
    await page.mouse.move(
      box.x + box.width * 0.55 + 2,
      box.y + box.height * 0.45,
    );
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
    await page.waitForTimeout(300);
    assert.equal(await frame.evaluate(() => window.selectedBarTime), selected);
    const displayed = (await ui.locator("body").innerText())
      .split("\n")
      .map((s) => s.trim());
    for (const [label, field] of [
      ["开盘价", "open"],
      ["最高价", "high"],
      ["最低价", "low"],
      ["收盘价", "close"],
    ]) {
      const value = Number(
        displayed[displayed.lastIndexOf(label) + 1]
          .replaceAll(",", "")
          .replaceAll("−", "-"),
      );
      assert.equal(
        value,
        Number(Number(bar[field]).toFixed(2)),
        timezone + " " + label,
      );
    }
    const expectedTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(selected * 1000));
    assert.equal(
      displayed[displayed.lastIndexOf("时间") + 1],
      expectedTime,
      timezone,
    );
  }
  assert.deepEqual(errors, []);
  console.log("DATA_WINDOW_OHLC_VISIBLE", {
    selected,
    body: body.slice(-650),
    errors,
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
