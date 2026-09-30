// Two-minute warm eight-chart polling and subscription teardown acceptance.
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
  if (process.env.MARKET_WATCH_CANDIDATE_VIEWPORTS === "1")
    await page.route('**/viewports.js', route => route.fulfill({
      path: '../advanced-host/viewports.js', contentType: 'application/javascript',
    }));
  const errors = [];
  let phase = "initialization";
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("EIGHT_CHART_ERROR", JSON.stringify({phase, message:e.message, stack:e.stack}));
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
  const originalWorkspace = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  const ui = frame.childFrames()[0];
  assert.ok(ui);
  await frame.evaluate(() => widget.setLayout("8"));
  await frame.waitForFunction(
    () =>
      widget.chartsCount() === 8 &&
      Array.from({ length: 8 }, (_, i) => widget.chart(i)).every((c) =>
        c.dataReady(),
      ),
    null,
    { timeout: 60000 },
  );
  const mixed = process.env.MARKET_WATCH_MIXED_SOAK === "1";
  if (mixed) {
    phase = "mixed-symbols-and-studies";
    await frame.evaluate(async () => {
      widget.symbolSync().setValue(false);
      const symbols = ["XAUUSD", "EURUSD", "BTCUSDT"];
      for (let i = 0; i < 8; i++) {
        const c = widget.chart(i);
        await new Promise((ok) => c.setSymbol(symbols[i % 3], ok));
        await c.createStudy("Moving Average", false, false, { length: 21 });
      }
    });
    await frame.waitForFunction(
      () =>
        Array.from({ length: 8 }, (_, i) => widget.chart(i)).every(
          (c) => c.dataReady() && c.getAllStudies().length === 1,
        ),
      null,
      { timeout: 90000 },
    );
  }

  const mode=process.env.MARKET_WATCH_LAYOUT_PROBE || 'baseline';
  await frame.evaluate(mode=>{
    if(mode==='no-progressive') clearInterval(progressivePoll);
    if(mode==='no-sync') widget.dateRangeSync().setValue(false);
  },mode);
  await frame.evaluate(()=>clearInterval(poll));
  await frame.waitForFunction(()=>!polling);
  await page.waitForTimeout(1100);
  for(let i=0;i<3;i++) {
    phase='collapse-'+i;
    await frame.evaluate(()=>widget.setLayout('s'));
    await frame.waitForFunction(()=>widget.chartsCount()===1 && widget.activeChart().dataReady());
    await page.waitForTimeout(1500);
    await frame.evaluate(()=>tick());
    phase='expand-'+i;
    await frame.evaluate(()=>widget.setLayout('8'));
    await frame.waitForFunction(()=>widget.chartsCount()===8 &&
      Array.from({length:8},(_,i)=>widget.chart(i)).every(c=>c.dataReady()),null,{timeout:60000});
    await frame.evaluate(()=>tick());
    await page.waitForTimeout(1500);
  }
  console.log('LAYOUT_PROBE',JSON.stringify({mode,errors}));
  await browser.close();
  assert.deepEqual(errors,[]);
})().catch(error=>{console.error(error);process.exit(1)});
