// Actual quote polling failure must clear only its own error after reconnection.
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
  const originalWorkspace = await page
    .locator("iframe[data-workspace-id]")
    .getAttribute("data-workspace-id");
  const ui = frame.childFrames()[0];
  assert.ok(ui);
  await frame.evaluate(async()=>(await widget.widgetbar()).showPage('watchlist_details_news'));
  await frame.waitForFunction(()=>quoteSubscriptions.size>0);
  await frame.evaluate(()=>clearInterval(poll));
  await frame.waitForFunction(()=>!polling);
  await page.waitForTimeout(1100);
  let blocked=0;
  await page.route('**/api/market-data/quotes',route=>{blocked++;return route.abort('failed');});
  await frame.evaluate(()=>tick());
  assert.ok(blocked>0,'Fault must reach actual quote request');
  assert.equal(await frame.evaluate(()=>polling),false);
  const alert=page.locator('[role="alert"]');
  await alert.first().waitFor({state:'visible'});
  await page.unroute('**/api/market-data/quotes');
  await page.waitForTimeout(1100);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/market-data/quotes'));
  await frame.evaluate(()=>tick());
  const recovered=await response;
  assert.equal(recovered.status(),200);
  assert.ok((await recovered.json()).some(row=>row.s==='ok' && Number.isFinite(row.v.lp)));
  assert.equal(await frame.evaluate(()=>polling),false);
  assert.equal(await frame.evaluate(()=>pending.size),0);
  await page.waitForFunction(()=>![...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent.includes('Failed to fetch')),null,{timeout:5000});
  await frame.evaluate(()=>{
    send({type:'error',error:'验收：保存失败，请重试'});
    send({type:'feed-poll-state',key:'EURUSD|5',error:'验收：独立K线错误'});
  });
  await frame.evaluate(()=>tick());
  await page.getByRole('alert').filter({hasText:'验收：保存失败，请重试'}).waitFor();
  await frame.evaluate(()=>send({type:'status',text:'行情已加载'}));
  await page.getByRole('alert').filter({hasText:'验收：独立K线错误'}).waitFor();
  await frame.evaluate(()=>send({type:'feed-poll-state',key:'EURUSD|5',error:''}));
  await page.waitForFunction(()=>document.querySelectorAll('[role="alert"]').length===0);
  assert.deepEqual(errors,[]);
  console.log('QUOTE_NETWORK_RECOVERED',{blocked,alerts:await alert.allTextContents(),errors});
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
