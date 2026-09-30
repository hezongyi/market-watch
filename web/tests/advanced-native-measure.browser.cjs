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
  await frame.evaluate(async()=>{
    await widget.activeChart().setSymbol('XAUUSD');
    await widget.activeChart().setResolution('60');
  });
  await frame.waitForFunction(()=>widget.activeChart().dataReady());
  const before=await frame.evaluate(()=>{
    const scale=widget.activeChart().getPanes()[0].getMainSourcePriceScale();
    const original=scale.getVisiblePriceRange();
    scale.setAutoScale(false);
    scale.setVisiblePriceRange({from:1,to:2});
    return original;
  });
  console.log('SCALE_BEFORE',JSON.stringify(before));
  console.log('AUTO_BUTTONS',await ui.getByText('自动',{exact:true}).count());
  await ui.getByText('自动',{exact:true}).click();
  await frame.waitForFunction(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().isAutoScale());
  const restored=await frame.evaluate(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange());
  assert.ok(restored.from>100 && restored.to>restored.from);
  const box=await ui.locator('.chart-container').first().boundingBox();
  await frame.evaluate(async()=>{widget.magnetEnabled().setValue(false);await widget.selectLineTool('measure');});
  await page.mouse.move(box.x+box.width*.3,box.y+box.height*.4);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.6,box.y+box.height*.65,{steps:15});

  await page.screenshot({path:'/tmp/mw-native-measure.png'});
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await ui.getByText('log',{exact:true}).click();
  assert.equal(await frame.evaluate(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().getMode()),1);
  await ui.getByText('log',{exact:true}).click();
  assert.equal(await frame.evaluate(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().getMode()),0);
  await frame.evaluate(()=>{
    const c=widget.activeChart();
    c.getTimeScale().setRightOffset(-50);
    c.getPanes()[0].getMainSourcePriceScale().setAutoScale(false);
    c.getPanes()[0].getMainSourcePriceScale().setVisiblePriceRange({from:1,to:2});
  });
  await page.mouse.click(box.x+box.width*.5,box.y+box.height*.45,{button:'right'});
  await page.waitForTimeout(700);
  console.log('CHART_CONTEXT_MENU',(await ui.locator('body').innerText()).slice(-5000));
  await page.screenshot({path:'/tmp/mw-native-context-menu.png'});
  await ui.getByText('重置图表视图',{exact:true}).click();
  await frame.waitForFunction(()=>{
    const c=widget.activeChart();
    return c.getTimeScale().rightOffset()>=0 && c.getPanes()[0].getMainSourcePriceScale().isAutoScale() && c.getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange().from>100;
  });
  assert.deepEqual(errors,[]);
  console.log('AUTO_SCALE_RESTORED',JSON.stringify(restored));
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
