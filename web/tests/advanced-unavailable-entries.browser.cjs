// Native price-axis autoscale and ruler interaction acceptance.
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
  await ui.getByRole('button',{name:'图表功能与替代入口说明'}).click();
  await ui.getByText('图表功能说明',{exact:true}).waitFor();
  const guide=await ui.locator('body').innerText();
  for(const label of ['保存样式','导出 CSV','不包含原生内置指标值','交易暂未接入','成交量、盘口、新闻']) assert.ok(guide.includes(label),label);
  console.log('GUIDE_VERIFIED');
  await page.screenshot({path:'/tmp/mw-entry-guide.png'});
  await page.keyboard.press('Escape');
  console.log('ENTRY_BUTTONS',await ui.getByRole('button').evaluateAll(items=>items.map(e=>({text:e.textContent,label:e.getAttribute('aria-label'),title:e.getAttribute('title')}))));
  const close=ui.getByRole('button',{name:'关闭交易面板',exact:true});
  if(await close.isVisible()) await close.click();
  const manager=ui.getByText('账户管理器',{exact:true}).filter({visible:true}).first();
  await manager.waitFor();
  await page.screenshot({path:'/tmp/mw-entry-collapsed.png'});
  await manager.click();
  await close.waitFor({state:'visible'});
  await page.waitForTimeout(500);
  await page.screenshot({path:'/tmp/mw-entry-trading-probe.png'});

  assert.deepEqual(errors,[]);
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
