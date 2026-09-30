// Native public API feasibility: controlled continuous daily history grows progressively.
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
    await widget.activeChart().setSymbol('BTCUSDT');
    window.progressiveBars = [];
    const original = feed.getBars;
    feed.getBars = (symbol,res,period,callback,error) => {
      if(res !== '1D') return original(symbol,res,period,callback,error);
      const bars = window.progressiveBars.filter(b=>b.time < period.to*1000).slice(-period.countBack);
      setTimeout(()=>callback(bars,{noData:true}),0);
    };
    await widget.activeChart().setResolution('1D');
  });
  await page.waitForTimeout(500);
  assert.equal(await frame.evaluate(()=>widget.activeChart().resolution()),'1D');
  async function supply(count) {
    await frame.evaluate(count=>{
      const end = Date.UTC(2026,8,28);
      window.progressiveBars = Array.from({length:count},(_,i)=>({
        time:end-(count-i)*86400000,open:4300+i,high:4305+i,low:4295+i,close:4301+i
      }));
      widget.resetCache();
      widget.activeChart().resetData();
    },count);
    await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:10000});
    await page.waitForTimeout(500);
  }
  await supply(20);
  await frame.evaluate(()=>widget.activeChart().getTimeScale().setBarSpacing(6));
  const before=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()}));
  await supply(80);
  const after=await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()}));
  console.log('PROGRESSIVE_PUBLIC_API',JSON.stringify({before,after}));
  assert.equal(after.spacing,before.spacing);
  assert.ok(Math.abs(after.range.to-before.range.to)<=86400,'latest edge must remain stable');
  await frame.evaluate(()=>widget.activeChart().setVisibleRange({
    from:Date.UTC(2026,7,1)/1000,to:Date.UTC(2026,7,21)/1000
  }));
  const historical=await frame.evaluate(()=>widget.activeChart().getVisibleRange());
  await supply(120);
  const historicalAfter=await frame.evaluate(()=>widget.activeChart().getVisibleRange());
  console.log('HISTORICAL_GROWTH',JSON.stringify({historical,historicalAfter}));
  assert.deepEqual(historicalAfter,historical,'history addition must retain browsed dates');
  await frame.evaluate(()=>widget.activeChart().setResolution('5'));
  await frame.waitForFunction(()=>widget.activeChart().resolution()==='5' && widget.activeChart().dataReady(),null,{timeout:20000});
  console.log('PASS: empty daily -> 20 -> 80 bars -> M5 using public reset API');
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
