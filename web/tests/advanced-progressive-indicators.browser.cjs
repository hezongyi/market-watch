// Real local Python synthetic datafeed: no blocking planner, computed values.
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


  await frame.evaluate(async()=> {
    widget.dateRangeSync().setValue(false);
    await widget.activeChart().setResolution('60');
  });
  await frame.waitForFunction(()=>widget.activeChart().dataReady());
  let planners=0;
  page.on('request',r=>{if(r.url().endsWith('/market-data/history')) planners++;});
  await page.evaluate(() => {
    window.indicatorProbe = {running:true, samples:[]};
    const probe = window.indicatorProbe;
    probe.done = (async()=>{
      while(probe.running) {
        const started=performance.now();
        const response=await fetch('/api/session');
        await response.json();
        probe.samples.push({ms:performance.now()-started,status:response.status});
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    })();
  });
  const result=await frame.evaluate(async()=>{
    const symbol=widget.activeChart().symbol();
    const ticker='MWPY_'+btoa(JSON.stringify({symbol,spec:{name:'SMA',params:{period:20}},key:'value'}));
    const started=performance.now();
    const value=await new Promise((resolve,reject)=>feed.getBars({ticker},'60',
      {to:Math.floor(Date.now()/1000),countBack:100,firstDataRequest:true},
      (bars,meta)=>resolve({bars,meta}),reject));
    return {...value,elapsed:performance.now()-started};
  });
  const probes=await page.evaluate(async()=>{
    window.indicatorProbe.running=false;
    await window.indicatorProbe.done;
    return window.indicatorProbe.samples;
  });
  assert.ok(probes.length>0);
  assert.ok(probes.every(p=>p.status===200 && p.ms<5000),
    'session requests must remain responsive during indicator computation: '+JSON.stringify(probes));
  console.log('CONCURRENT_SESSION',JSON.stringify(probes));
  assert.equal(planners,0,'Python M1-D1 requests must not enter blocking planner');
  assert.ok(result.bars.length>0,'real local history must supply study bars');
  assert.ok(result.bars.some(b=>b.volume===1),'SMA must have computed values');
  console.log('PYTHON_PROGRESSIVE',JSON.stringify({bars:result.bars.length,elapsed:result.elapsed,planners}));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
