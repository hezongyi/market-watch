// Measure native dataReady and next paint opportunities, not GPU render completion.
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
  const samples=[];
  for (let round=0;round<2;round++) {
    for (const resolution of ['1','5','15','30','60','240','1D']) {
      const sample=await frame.evaluate(async resolution=>{
        const chart=widget.activeChart();
        const start=performance.now();
        await chart.setResolution(resolution);
        const callbackMs=performance.now()-start;
        await new Promise(resolve=>chart.dataReady(resolve));
        const readyMs=performance.now()-start;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {resolution,callbackMs,readyMs,paintOpportunityMs:performance.now()-start,
          spacing:chart.getTimeScale().barSpacing(),range:chart.getVisibleRange()};
      },resolution);
      samples.push({round,...sample});
      console.log('SWITCH_TIMING',JSON.stringify({round,...sample}));
      assert.ok(sample.range.to>sample.range.from,'visible time range must exist');
      await page.waitForTimeout(1000);
    }
  }
  await page.screenshot({path:'/tmp/mw-switch-timing.png'});
  fs.writeFileSync('/tmp/mw-switch-timing.json',JSON.stringify(samples,null,2));
  await browser.close();
  assert.ok(samples.filter(s=>s.round===1).every(s=>s.paintOpportunityMs<=200),
    'Repeated cached M1–D1 switches must reach a paint opportunity within 200ms');
})().catch(e => { console.error(e); process.exit(1); });
