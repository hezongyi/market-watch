// Diagnostic: active BTC weekend viewport synchronized to closed FX/gold peers.
// Currently reproduces a remaining acceptance failure; not a passing regression.
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
  page.on("pageerror", (e) => errors.push({message:e.message, stack:e.stack}));
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
  await frame.evaluate(()=>widget.setLayout('3s'));
  await frame.waitForFunction(()=>widget.chartsCount()===3);
  await frame.evaluate(async()=>{
    widget.symbolSync().setValue(false);
    for(const [i,symbol] of ['BTCUSDT','XAUUSD','EURUSD'].entries()) {
      await widget.chart(i).setSymbol(symbol, {doNotActivateChart:true});
      await widget.chart(i).setResolution('5', {doNotActivateChart:true});
    }
  });
  await frame.waitForFunction(()=>[0,1,2].every(i=>widget.chart(i).dataReady()));
  await frame.evaluate(()=>{widget.setActiveChart(0);widget.dateRangeSync().setValue(true);});
  const outcome=await frame.evaluate(async()=>{
    const target={from:1790424000,to:1790434800};
    try {await widget.chart(0).setVisibleRange(target,{rejectByTimeout:10000});return {target,ok:true};}
    catch(e){return {target,error:String(e)};}
  });
  await page.waitForTimeout(3000);
  const state = await frame.evaluate(()=>({busy:rangeGuard?.busy(),edge:edgeGuard?.busy(),charts:[0,1,2].map(i=>({symbol:widget.chart(i).symbol(),range:widget.chart(i).getVisibleRange(),ready:widget.chart(i).dataReady()}))}));
  console.log('CLOSED_WINDOW_STATE',JSON.stringify({outcome,state,errors}));
  await page.screenshot({path:'/tmp/mw-closed-window.png'});
  await browser.close();
  assert.equal(state.busy, false);
  assert.equal(state.edge, false);
  for (const chart of state.charts) {
    assert.ok(chart.ready, chart.symbol + ' must finish loading');
    assert.ok(Math.abs(chart.range.to - outcome.target.to) <= 300,
      chart.symbol + ' must align to the active weekend viewport');
  }
  assert.deepEqual(errors,[]);
})().catch(e=>{console.error(e);process.exit(1)});
