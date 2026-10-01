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
    await page.route('**/bridge.js*',route=>route.fulfill({contentType:'application/javascript',
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

  const symbol=process.env.MARKET_WATCH_COLD_SYMBOL;
  assert.ok(symbol,'Choose a database-verified empty instrument');
  const frames=['M1','M5','M15','M30','H1','H4','D1'];
  const start=Date.now(),first={},full={},samples=[];
  page.on('console',message=>{
    if(message.text().startsWith('COLD_FEED')) console.log(message.text());
  });
  await frame.evaluate(()=>{
    const original=feed.getBars;
    feed.getBars=(s,r,p,cb,err)=>{
      const began=performance.now();
      console.log('COLD_FEED request',JSON.stringify({symbol:s.ticker,r,p}));
      return original(s,r,p,(bars,meta)=>{
        console.log('COLD_FEED response',JSON.stringify({symbol:s.ticker,r,p,count:bars.length,
          first:bars[0]?.time,last:bars.at(-1)?.time,elapsed:performance.now()-began,meta}));
        cb(bars,meta);
      },err);
    };
  });
  await frame.evaluate(async symbol=>{
    widget.dateRangeSync().setValue(false);
    await widget.activeChart().setResolution('1D');
    await widget.activeChart().setSymbol(symbol);
    const scale=widget.activeChart().getTimeScale();
    scale.setBarSpacing(scale.width()/200);
  },symbol);
  console.log('COLD_START',JSON.stringify({symbol,start}));
  while(Date.now()-start<900000 && Object.keys(full).length<frames.length) {
    const counts=await frame.evaluate(async ({symbol,frames})=>{
      const result={};
      for(const timeframe of frames) {
        const page=await request({op:'historyCache',args:{instrument:symbol,timeframe,limit:200}},'market');
        result[timeframe]=page.bars.length;
      }
      const chart=widget.activeChart();
      return {bars:result,range:chart.getVisibleRange(),ready:chart.dataReady(),
        spacing:chart.getTimeScale().barSpacing(),offset:chart.getTimeScale().rightOffset(),
        symbol:chart.symbol(),resolution:chart.resolution(),
        historyReloading,rangeBusy:rangeGuard?.busy(),edgeBusy:edgeGuard?.busy(),
        nativeFirst:firstHistory.get(chart.symbol()+'|'+chart.resolution()),
        nativeLast:lastHistory.get(chart.symbol()+'|'+chart.resolution())};
    },{symbol,frames});
    const elapsed=Date.now()-start;
    for(const f of frames) {
      if(counts.bars[f]>0 && first[f]===undefined) first[f]=elapsed;
      if(counts.bars[f]>=200 && full[f]===undefined) full[f]=elapsed;
    }
    samples.push({elapsed,...counts});
    console.log('COLD_SAMPLE',JSON.stringify(samples.at(-1)));
    fs.writeFileSync('/tmp/mw-cold-200-timing.json',JSON.stringify({symbol,start,first,full,samples},null,2));
    await page.screenshot({path:'/tmp/mw-cold-200-progress.png'});
    await page.waitForTimeout(5000);
  }
  console.log('COLD_RESULT',JSON.stringify({symbol,first,full}));
  await page.screenshot({path:'/tmp/mw-cold-200.png'});
  const initiallyVisible=samples.find(sample=>sample.ready && sample.nativeFirst);
  const final=samples.at(-1);
  assert.ok(initiallyVisible && final.nativeFirst<initiallyVisible.nativeFirst,
    'New older bars must reach the native series, not only the backend cache');
  assert.ok(final.range.from<initiallyVisible.range.from,
    'Cold daily viewport must progressively expand into loaded history');
  assert.equal(await page.getByText('Error: 历史刷新等待超时',{exact:true}).count(),0,
    'Cold history must not leave a refresh timeout banner');
  await browser.close();
  assert.equal(Object.keys(full).length,frames.length,'Every period must reach 200 local bars within observation window');
})().catch(e=>{console.error(e.message);process.exit(1)});
