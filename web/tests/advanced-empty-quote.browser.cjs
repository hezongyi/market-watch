// Registered OANDA symbol quote details recover and display local price.
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
  await page.route('**/api/market-data/quotes',async route=>{
    const response=await route.fetch();const rows=await response.json();
    for(const row of rows)if(row.n==='OANDA:EUR_CAD') {
      row.s='ok';row.v={short_name:'EUR_CAD',description:'EUR/CAD · 报价准备中',exchange:'OANDA'};
    }
    await route.fulfill({response,json:rows});
  });
  page.on('response',async r=>{
    if(r.url().endsWith('/market-data/quotes')) console.log('QUOTES',JSON.stringify({request:r.request().postDataJSON(),response:await r.json().catch(()=>null)}));
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

  const ui=frame.childFrames()[0];
  await ui.getByRole('button',{name:'查看后台补数进度',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('heading',{name:'历史任务'}).waitFor();
  console.log('TASK_PANEL_OPEN');
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  const symbol=process.env.MARKET_WATCH_COLD_SYMBOL || 'OANDA:EUR_AUD';
  const reports=[];
  page.on('response',async response=>{
    if(!response.url().endsWith('/market-data/history/cache'))return;
    const args=response.request().postDataJSON();
    if(args.instrument!==symbol)return;
    const result=await response.json().catch(()=>null);
    if(result)reports.push({at:Date.now(),frame:args.timeframe,bars:result.bars.length});
  });
  await frame.evaluate(async symbol=>{
    widget.dateRangeSync().setValue(false);
    await widget.activeChart().setResolution('60');
    await widget.activeChart().setSymbol(symbol);
  },symbol);
  const start=Date.now();
  for(const resolution of ['1D','5','60']) {
    const t=Date.now();
    await frame.evaluate(r=>widget.activeChart().setResolution(r),resolution);
    console.log('COLD_SWITCH',resolution,Date.now()-t);
  }
  let count=0;
  for(let i=0;i<36;i++) {
    await page.waitForTimeout(2500);
    count=reports.filter(r=>r.frame==='H1' && r.bars>0).length;
    if(count)break;
  }
  console.log('COLD_HISTORY',JSON.stringify({elapsed:Date.now()-start,reports}));
  assert.ok(count,'cold H1 must acquire bars within 90 seconds');
  await page.waitForTimeout(8000);
  await ui.getByText('无效的商品代码',{exact:true}).waitFor({state:'hidden',timeout:30000});
  const quote=await page.evaluate(async symbol=>{
    const session=await (await fetch('/api/session')).json();
    const response=await fetch('/api/market-data/quotes',{method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
      body:JSON.stringify({symbols:[symbol]})});
    return (await response.json())[0];
  },symbol);
  assert.equal(quote.s,'ok');
  assert.equal(quote.n,symbol);
  assert.equal(quote.v.lp,undefined);
  await page.screenshot({path:'/tmp/mw-empty-quote.png'});
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
