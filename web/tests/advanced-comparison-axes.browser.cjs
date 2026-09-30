// Comparison across BTC/gold sessions, independent raw-price axes and percent persistence.
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
  const ui = frame.childFrames()[0];
  assert.ok(ui);
  await frame.evaluate(async()=>{
    await widget.activeChart().setSymbol('BTCUSDT');
    await widget.activeChart().setResolution('60');
    window.compareId=await widget.activeChart().createStudy('Compare',true,false,{symbol:'XAUUSD'},undefined,{priceScale:'new-left'});
  });
  await frame.waitForFunction(()=>{
    const p=widget.activeChart().getPanes()[0],l=p.getLeftPriceScales();
    return l.length===1 && l[0].getVisiblePriceRange()?.from>1000 && p.getMainSourcePriceScale().getVisiblePriceRange()?.from>10000;
  });
  const original=await frame.evaluate(()=>{
    const c=widget.activeChart(),p=c.getPanes()[0];
    return {left:p.getLeftPriceScales()[0].getVisiblePriceRange(),right:p.getMainSourcePriceScale().getVisiblePriceRange(),tracked:hasHistoryViewer({instrument:'XAUUSD',timeframe:'H1'})};
  });
  assert.equal(original.tracked,true);
  assert.ok(original.left.to<10000 && original.right.from>10000,'independent gold and BTC raw-price scales');
  await page.screenshot({path:'/tmp/mw-compare-independent-axes.png'});
  await frame.evaluate(()=>{
    const p=widget.activeChart().getPanes()[0];
    p.getLeftPriceScales()[0].setMode(2);
    p.getMainSourcePriceScale().setMode(2);
  });
  await frame.waitForFunction(()=>!nativeSaving && !edgeGuard.busy() && !rangeGuard.busy());
  await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
  await page.reload();
  await page.waitForTimeout(15000);
  const restoredFrame=page.frames().find(f=>f.url().startsWith('https://127.0.0.1:15444/'));
  await restoredFrame.waitForFunction(()=>ready && !loading && widget.activeChart().dataReady() && widget.activeChart().getPanes()[0].getLeftPriceScales().length===1);
  const restored=await restoredFrame.evaluate(()=>{
    const c=widget.activeChart(),p=c.getPanes()[0];
    return {symbol:c.symbol(),resolution:c.resolution(),modes:[p.getLeftPriceScales()[0].getMode(),p.getMainSourcePriceScale().getMode()],studies:c.getAllStudies().map(s=>c.getStudyById(s.id).getInputValues()),tracked:hasHistoryViewer({instrument:'XAUUSD',timeframe:'H1'})};
  });
  assert.equal(restored.symbol,'BTCUSDT');
  assert.deepEqual(restored.modes,[2,2]);
  assert.ok(restored.studies.some(s=>s.some(v=>v.id==='symbol' && v.value==='XAUUSD')));
  assert.equal(restored.tracked,true);
  await page.screenshot({path:'/tmp/mw-compare-percent-restored.png'});
  assert.deepEqual(errors,[]);
  console.log('COMPARE_MULTI_AXIS_RESTORE',JSON.stringify({original,restored,errors}));
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
