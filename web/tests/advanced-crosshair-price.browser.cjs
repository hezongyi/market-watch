// Crosshair rendering and independent price axes across EURUSD, XAUUSD and BTCUSDT.
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
  await frame.evaluate(()=>{widget.dateRangeSync().setValue(false);widget.timeSync().setValue(false);widget.symbolSync().setValue(false);widget.setLayout('3h');});
  await frame.waitForFunction(()=>widget.chartsCount()===3 && [0,1,2].every(i=>widget.chart(i).dataReady()));
  await frame.evaluate(async()=>{
    const symbols=['EURUSD','XAUUSD','BTCUSDT'];
    for(let i=0;i<3;i++) {
      await widget.chart(i).setSymbol(symbols[i],{doNotActivateChart:true});
      await widget.chart(i).setResolution('5',{doNotActivateChart:true});
      widget.chart(i).applyOverrides({'paneProperties.crossHairProperties.color':'#ff00ff','paneProperties.crossHairProperties.width':2,'paneProperties.crossHairProperties.style':0});
    }
    widget.crosshairSync().setValue(true);
  });
  await frame.waitForFunction(()=>[0,1,2].every(i=>widget.chart(i).dataReady()));
  const before=await frame.evaluate(()=>[0,1,2].map(i=>widget.chart(i).getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange()));
  const box=await ui.locator('.chart-container').first().boundingBox();
  await page.mouse.move(box.x+box.width*.55,box.y+box.height*.45,{steps:12});
  await page.waitForTimeout(500);
  const pixels=await ui.locator('.chart-container').evaluateAll(charts=>charts.map(chart=>[...chart.querySelectorAll('canvas')].map(canvas=>{
    const ctx=canvas.getContext('2d');
    if(!ctx) return null;
    const w=canvas.width,h=canvas.height,data=ctx.getImageData(0,0,w,h).data;
    const rows=new Array(h).fill(0),cols=new Array(w).fill(0);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const n=(y*w+x)*4;
      if(data[n]>220 && data[n+1]<50 && data[n+2]>220 && data[n+3]>150){rows[y]++;cols[x]++;}
    }
    return {w,h,maxRow:Math.max(...rows),maxCol:Math.max(...cols)};
  })));
  const after=await frame.evaluate(()=>[0,1,2].map(i=>widget.chart(i).getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange()));
  console.log('CROSSHAIR_RENDER',JSON.stringify({before,after,pixels}));
  await page.screenshot({path:'/tmp/mw-crosshair-price-isolation.png'});
  assert.deepEqual(before,after,'crosshair must not move independent price axes');
  assert.equal(pixels.length,3);
  for (let i=0;i<3;i++) {
    const chartCanvases=pixels[i].filter(c=>c && c.w>200 && c.h>200);
    assert.ok(chartCanvases.some(c=>c.maxCol>c.h*.8),'pane '+i+' must render synchronized vertical time line');
    if(i===0) assert.ok(chartCanvases.some(c=>c.maxRow>c.w*.8),'active pane must show horizontal price line');
    else assert.ok(chartCanvases.every(c=>c.maxRow<c.w*.1),'different symbol must not render active horizontal price line');
  }
  assert.deepEqual(errors,[]);
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
