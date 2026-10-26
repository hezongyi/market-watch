// Controlled historical revisions followed by native eight-pane layout changes.
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
  if (process.env.MARKET_WATCH_CANDIDATE_BRIDGE === "1")
    await page.route('**/chart-runtime.js',route=>route.fulfill({
      path:'../advanced-host/chart-runtime.js',contentType:'application/javascript',
    }));
  const errors = [];
  let phase = "initialization";
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("EIGHT_CHART_ERROR", JSON.stringify({phase, message:e.message, stack:e.stack}));
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

  const mode='historical-revision';
  let revision=0;
  await page.route('**/api/market-data/history/cache',async route=>{
    let response;
    try { response=await route.fetch(); } catch {
      if (!page.isClosed()) errors.push('History response interception failed');
      await route.abort().catch(()=>{});
      return;
    }
    const body=await response.json();
    if(revision && body.bars?.length) {
      const closed=body.bars.find(bar=>bar.complete);
      if(closed) {closed.revision=(closed.revision||0)+revision;closed.high=Number(closed.high)+0.00001*revision;}
    }
    await route.fulfill({response,json:body});
  });
  await frame.evaluate(()=>{
    clearInterval(poll);clearInterval(progressivePoll);
    window.refreshCount=0;
    const original=refreshChartHistory;
    refreshChartHistory=async(...args)=>{window.refreshCount++;return original(...args);};
  });
  await frame.waitForFunction(()=>!polling);
  for(let i=0;i<3;i++) {
    revision++;
    phase='revision-'+i;
    const previous=await frame.evaluate(()=>window.refreshCount);
    await frame.evaluate(()=>{window.revisionPoll=progressivePages.poll();});
    await frame.waitForFunction(previous=>window.refreshCount>previous,previous,{timeout:15000});
    phase='collapse-'+i;
    await frame.evaluate(()=>widget.setLayout('s'));
    await frame.waitForFunction(()=>widget.chartsCount()===1 && widget.activeChart().dataReady());
    await page.waitForTimeout(500);
    phase='expand-'+i;
    await frame.evaluate(()=>widget.setLayout('8'));
    await frame.waitForFunction(()=>widget.chartsCount()===8 &&
      Array.from({length:8},(_,i)=>widget.chart(i)).every(c=>c.dataReady()),null,{timeout:60000});
    await page.waitForTimeout(500);
    await frame.evaluate(()=>window.revisionPoll);
  }
  console.log('LAYOUT_PROBE',JSON.stringify({mode,errors}));
  await browser.close();
  assert.deepEqual(errors,[]);
})().catch(error=>{console.error(error);process.exit(1)});
