// Real daily session labels and OHLC under three display timezones.
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
  const checks=[];
  for(const symbol of ['XAUUSD','BTCUSDT']) {
    await frame.evaluate(symbol=>new Promise(ok=>widget.activeChart().setSymbol(symbol,ok)),symbol);
    await frame.evaluate(()=>new Promise(ok=>widget.activeChart().setResolution('1D',ok)));
    await frame.waitForFunction(()=>widget.activeChart().dataReady());
    await frame.evaluate(()=>{globalThis.selectedDailyTime=null;widget.activeChart().crossHairMoved().subscribe(null,e=>globalThis.selectedDailyTime=e.time);});
    const button=ui.getByRole('button',{name:/数据窗口/});
    if(await button.getAttribute('aria-pressed')!=='true')await button.click();
    for(const zone of ['Etc/UTC','Asia/Singapore','America/New_York']) {
      await frame.evaluate(zone=>widget.activeChart().getTimezoneApi().setTimezone(zone),zone);
      const box=await ui.locator('.chart-container').first().boundingBox();
      await page.mouse.move(box.x+box.width*.53+3,box.y+box.height*.45);
      await page.mouse.move(box.x+box.width*.53,box.y+box.height*.45,{steps:8});
      await frame.waitForFunction(()=>selectedDailyTime>0);
      await page.waitForTimeout(300);
      await Promise.all(responses);
      const selected=await frame.evaluate(()=>selectedDailyTime);
      const date=new Date(selected*1000).toISOString().slice(0,10);
      const marketZone=symbol==='BTCUSDT'?'UTC':'America/New_York';
      const bar=[...history.values()].find(b=>b.end-b.start>20*3600000 && new Intl.DateTimeFormat('en-CA',{timeZone:marketZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(b.end-1))===date);
      assert.ok(bar,'Selected daily label must correspond to a real backend session: '+date);
      const lines=(await ui.locator('body').innerText()).split('\n').map(v=>v.trim());
      assert.ok(lines[lines.lastIndexOf('日期')+1].includes(date));
      for(const [label,field] of [['开盘价','open'],['最高价','high'],['最低价','low'],['收盘价','close']]) {
        const value=Number(lines[lines.lastIndexOf(label)+1].replaceAll(',','').replaceAll('−','-'));
        assert.equal(value,Number(Number(bar[field]).toFixed(2)),symbol+' '+zone+' '+label);
      }
      checks.push({symbol,zone,date,start:bar.start,end:bar.end});
    }
  }
  assert.deepEqual(errors,[]);
  console.log('DAILY_LABELS_OHLC_MATCH_REAL_SESSIONS',{checks,errors});
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
