// Regression: delayed obsolete histories must not block the final M5 view.
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
      body: JSON.stringify({ name: "XAUUSD周期柱宽回归" }),
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
  await frame.evaluate(async () => {
    widget.dateRangeSync().setValue(false);
    await widget.activeChart().setSymbol('XAUUSD');
    await widget.activeChart().setResolution('60');
    widget.activeChart().getTimeScale().setBarSpacing(6);
  });

  await frame.evaluate(()=>widget.activeChart().setResolution('5'));
  let held=0;
  await page.route('**/api/market-data/history/cache',async route=>{
    const q=route.request().postDataJSON();
    if(q.timeframe==='H1' && q.before && q.before<Date.UTC(2020,0,1)) {
      held++;
      return route.fulfill({json:{bars:[],coverage:[],local_only:true,remote_boundary:'unknown'}});
    }
    return route.fallback();
  });
  await frame.evaluate(async()=>{
    await widget.activeChart().setResolution('60');
    window.navigationProbe={done:false,error:null};
    feed.getBars({ticker:'XAUUSD'},'60',{
      from:Date.UTC(2017,7,16)/1000,to:Date.now()/1000,countBack:100000,firstDataRequest:false,
    },()=>{window.navigationProbe.done=true;},error=>{
      window.navigationProbe.done=true;window.navigationProbe.error=String(error);
    });
  });
  await page.waitForFunction(()=>true);
  for(let i=0;i<50 && !held;i++) await page.waitForTimeout(100);
  assert.ok(held,'navigation must enter unavailable target reads');
  const start=Date.now();
  await frame.evaluate(()=>widget.activeChart().setResolution('5'));
  await frame.waitForFunction(()=>widget.activeChart().resolution()==='5' && widget.activeChart().dataReady(),null,{timeout:5000});
  const elapsed=Date.now()-start;
  await frame.waitForFunction(()=>window.navigationProbe.done,null,{timeout:5000});
  const probe=await frame.evaluate(()=>window.navigationProbe);
  assert.ok(probe.error,'obsolete historical callback must be cancelled');
  console.log('NAVIGATION_CANCEL',JSON.stringify({elapsed,held,probe}));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
