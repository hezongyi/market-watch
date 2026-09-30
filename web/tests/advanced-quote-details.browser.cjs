// Real native quote details expose basis, freshness and timestamp without invented fields.
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
  await page.waitForTimeout(2000);
  const quote=await page.evaluate(async()=>{const r=await fetch('/api/session');const session=await r.json();const response=await fetch('/api/market-data/quotes',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({symbols:['XAUUSD']})});if(!response.ok)throw Error(response.status);return (await response.json())[0];});
  const text=await ui.locator('body').innerText();
  assert.ok(text.includes(quote.v.description),'Quote basis, quality and timestamp must be visible');
  assert.ok(text.includes(Number(quote.v.lp).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})),'Last M1 close must be visible');
  for(const field of ['ask','volume','market_cap'])assert.equal(quote.v[field],undefined);
  assert.ok(!/NaN|undefined|null/.test(text),'Missing values must not leak technical placeholders');
  console.log('QUOTE_DETAILS_VERIFIED',{description:quote.v.description,last:quote.v.lp,errors});
  await page.screenshot({path:'/tmp/mw-quote-details.png'});
  assert.deepEqual(errors,[]);
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
