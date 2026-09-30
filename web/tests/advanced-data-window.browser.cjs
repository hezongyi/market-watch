// Real backend OHLC, native SMA values, display timezones and warmup gaps.
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
  const pythonResults = [];
  page.on("response", (response) => {
    if (!/\/api\/(market-data\/history|charts\/data)$/.test(response.url()))
      return;
    responses.push(
      response
        .json()
        .then((data) => {
          pythonResults.push(...(data.indicators || []));
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
  await frame.evaluate(() =>
    widget
      .activeChart()
      .createStudy("Moving Average", false, false, { length: 5 }),
  );
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
  const previous = [...history.values()]
    .filter((b) => Number(b.start) <= selected * 1000)
    .sort((a, b) => Number(a.start) - Number(b.start))
    .slice(-5);
  assert.equal(previous.length, 5);
  const expectedSma = previous.reduce((sum, b) => sum + Number(b.close), 0) / 5;
  const indicatorLines = (await ui.locator("body").innerText())
    .split("\n")
    .map((s) => s.trim());
  const plotIndex = indicatorLines.lastIndexOf("Plot");
  assert.ok(plotIndex >= 0, "Native MA plot must be present in data window");
  const actualSma = Number(indicatorLines[plotIndex + 1].replaceAll(",", ""));
  assert.equal(
    actualSma,
    Number(expectedSma.toFixed(2)),
    "Native MA(5) versus independent backend-close average",
  );

  await frame.evaluate(() => {
    widget.activeChart().removeAllStudies();
    return widget.activeChart().createStudy("守望 Python SMA", false, false, {
      period: 5,
    });
  });
  const pythonValue = () =>
    pythonResults
      .filter((i) => i.name === "SMA")
      .flatMap((i) => i.series)
      .filter((line) => line.key === "value")
      .flatMap((line) => line.values)
      .find(
        (v) => Number(v.time) === selected * 1000 && Number.isFinite(v.value),
      );
  for (let attempt = 0; attempt < 30 && !pythonValue(); attempt++)
    await page.waitForTimeout(1000);
  assert.ok(pythonValue(), "Python SMA must return selected candle's value");
  assert.ok(
    Math.abs(pythonValue().value - expectedSma) < 1e-7,
    "Python backend SMA versus independent average",
  );
  // dataReady() describes the main series; Python secondary series can still
  // be loading. Read the displayed plot and its current crosshair together.
  let pythonSelected, pythonExpected, pythonDisplayed;
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.mouse.move(
      box.x + box.width * 0.55 + 2,
      box.y + box.height * 0.45,
    );
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
    await page.waitForTimeout(500);
    pythonSelected = await frame.evaluate(() => window.selectedBarTime);
    const pythonLines = (await ui.locator("body").innerText())
      .split("\n")
      .map((s) => s.trim());
    const pythonIndex = pythonLines.lastIndexOf("value");
    pythonDisplayed =
      pythonIndex < 0
        ? NaN
        : Number(pythonLines[pythonIndex + 1].replaceAll(",", ""));
    if (Number.isFinite(pythonDisplayed)) break;
    await page.waitForTimeout(500);
  }
  assert.ok(
    Number.isFinite(pythonDisplayed),
    "Python plot must finish loading",
  );
  await Promise.all(responses);
  assert.ok(
    history.has(pythonSelected * 1000),
    "Selected Python candle exists",
  );
  const pythonPrevious = [...history.values()]
    .filter((b) => Number(b.start) <= pythonSelected * 1000)
    .sort((a, b) => Number(a.start) - Number(b.start))
    .slice(-5);
  assert.equal(pythonPrevious.length, 5);
  pythonExpected =
    pythonPrevious.reduce((sum, b) => sum + Number(b.close), 0) / 5;
  assert.equal(
    pythonDisplayed,
    Number(pythonExpected.toFixed(5)),
    "Python data-window value must retain the adapter's five-digit precision",
  );
  console.log("PYTHON_WINDOW_SMA", {
    pythonSelected,
    pythonExpected,
    pythonDisplayed,
  });

  // A period longer than the available history must yield a missing value,
  // never a fabricated zero in the native data window.
  await frame.evaluate(() => {
    widget.activeChart().removeAllStudies();
    return widget.activeChart().createStudy("Moving Average", false, false, {
      length: 10000,
    });
  });
  await page.waitForTimeout(1500);
  await page.mouse.move(
    box.x + box.width * 0.55 + 2,
    box.y + box.height * 0.45,
  );
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await page.waitForTimeout(500);
  const warmupLines = (await ui.locator("body").innerText())
    .split("\n")
    .map((s) => s.trim());
  const warmupIndex = warmupLines.lastIndexOf("Plot");
  assert.ok(
    warmupIndex >= 0,
    "Warmup study must remain visible in data window",
  );
  const warmupValue = warmupLines[warmupIndex + 1];
  console.log("WARMUP_DISPLAY", { warmupValue });
  assert.ok(
    ["∅", "—", "n/a", "N/A"].includes(warmupValue),
    "Insufficient-history indicator must display a missing value: " +
      warmupValue,
  );
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
