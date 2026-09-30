// Native copy/paste independence and user-edited drawing defaults across workspaces.
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
  const box = await ui.locator(".chart-container").first().boundingBox();
  // Dismiss the native first-use chart hint before starting a two-click drawing.
  await page.mouse.click(box.x+box.width*0.25,box.y+box.height*0.3);
  const hint=ui.getByRole("button",{name:/了解/});
  await hint.waitFor({state:"visible",timeout:3000}).catch(e=>{if(e.name!=="TimeoutError")throw e;});
  if (await hint.isVisible()) await hint.click();
  await frame.evaluate(async () => {
    widget.magnetEnabled().setValue(true);
    widget.magnetMode().setValue(1);
    await widget.selectLineTool("trend_line");
  });
  for (const [x,y] of [[0.3,0.3],[0.7,0.35]]) {
    await page.mouse.move(box.x+box.width*x,box.y+box.height*y,{steps:8});
    await page.mouse.click(box.x+box.width*x,box.y+box.height*y);
    if (await hint.isVisible()) await hint.click();
  }
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await frame.waitForFunction(() => widget.activeChart().getAllShapes().length === 1);
  const result = await frame.evaluate(async () => {
    const c=widget.activeChart();
    const points=c.getShapeById(c.getAllShapes()[0].id).getPoints();
    const data=await query(c.symbol(),c.resolution(),{limit:300,before:1790622000000});
    return {points,bars:data.bars,enabled:widget.magnetEnabled().value(),mode:widget.magnetMode().value()};
  });
  assert.equal(result.enabled,true);
  for (const point of result.points) {
    const bar=result.bars.find(b=>b.start/1000===point.time);
    assert.ok(bar,"Snapped drawing anchor must refer to an actual bar: "+JSON.stringify(point));
    assert.ok([bar.open,bar.high,bar.low,bar.close].some(v=>Math.abs(v-point.price)<0.000001),
      "Strong magnet must snap to OHLC: "+JSON.stringify({point,bar}));
  }
  assert.deepEqual(errors,[]);
  console.log("STRONG_MAGNET_OHLC",{points:result.points,mode:result.mode,errors});
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
