// Actual provider cold-symbol acquisition and native task panel.
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
  if(process.env.MARKET_WATCH_BRIDGE_SOURCE)
    await page.route('**/chart-runtime.js*',route=>route.fulfill({contentType:'application/javascript',
      body:fs.readFileSync(process.env.MARKET_WATCH_BRIDGE_SOURCE,'utf8')}));
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
      body: JSON.stringify({ name: "冷启动200根逐周期计时" }),
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

  const symbol='OANDA:EUR_CHF';
  page.on('console',m=>{if(m.text().startsWith('COLD_NAV'))console.log(m.text());});
  await frame.evaluate(()=>{
    const original=feed.getBars;
    feed.getBars=(s,r,p,cb,err)=>{
      console.log('COLD_NAV request',JSON.stringify({symbol:s.ticker,r,p}));
      return original(s,r,p,(bars,meta)=>{
        console.log('COLD_NAV response',JSON.stringify({r,p,count:bars.length,
          first:bars[0]?.time,last:bars.at(-1)?.time,meta}));cb(bars,meta);
      },err);
    };
  });
  await frame.evaluate(async symbol=>{
    await widget.activeChart().setResolution('1D');
    await widget.activeChart().setSymbol(symbol);
  },symbol);
  await page.waitForTimeout(10000);
  console.log('REOPEN',JSON.stringify(await frame.evaluate(()=>({range:widget.activeChart().getVisibleRange(),
    ready:widget.activeChart().dataReady(),cold:[...coldHistory]}))));
  // A fixed date becomes warm as background acquisition advances.
  const earliest=await frame.evaluate(symbol=>firstHistory.get(symbol+'|1D'),symbol);
  assert.ok(Number.isFinite(earliest),'earliest loaded history must be known');
  const edge=Math.floor(earliest/86400000)*86400;
  const target={from:edge-30*86400,to:edge+14*86400};
  // Forex has no weekend candles; select a weekday instead of treating
  // native snapping to Friday as a failed history request.
  for(const key of ['from','to']) {
    while([0,6].includes(new Date(target[key]*1000).getUTCDay())) target[key]-=86400;
  }
  await frame.evaluate(async target=>{
    await widget.activeChart().setVisibleRange(target,{rejectByTimeout:20000});
  },target);
  await page.waitForTimeout(3000);
  const actual=await frame.evaluate(()=>widget.activeChart().getVisibleRange());
  console.log('COLD_JUMP',JSON.stringify({target,actual}));
  await page.screenshot({path:'/tmp/mw-cold-reopen.png'});
  await browser.close();
  assert.ok(Math.abs(actual.from-target.from)<=86400 && Math.abs(actual.to-target.to)<=86400,
    'Reopened partial history must support deliberate historical navigation');
})().catch(e=>{console.error(e.message);process.exit(1)});
