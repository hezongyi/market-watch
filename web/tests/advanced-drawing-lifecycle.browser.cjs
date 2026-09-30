// Shared drawing add/edit/delete and no resurrection after reload or period changes.
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
  await frame.evaluate(()=>widget.setLayout('2h'));
  await frame.waitForFunction(()=>widget.chartsCount()===2&&widget.chart(1).dataReady());
  await frame.evaluate(()=>new Promise(ok=>widget.chart(1).setResolution('15',ok)));
  const id=await frame.evaluate(()=>widget.chart(0).createShape({time:1790323200,price:4300},{shape:'horizontal_line'}));
  await frame.waitForFunction(()=>widget.chart(1).getAllShapes().length===1);
  await frame.evaluate(id=>widget.chart(0).getShapeById(id).setPoints([{time:1790323200,price:4333.21}]),id);
  await frame.waitForFunction(()=>{const c=widget.chart(1);return c.getShapeById(c.getAllShapes()[0].id).getPoints()[0].price===4333.21});
  await frame.evaluate(()=>new Promise(ok=>widget.chart(1).setSymbol('EURUSD',ok)));
  assert.equal(await frame.evaluate(()=>widget.chart(1).getAllShapes().length),0);
  await frame.evaluate(()=>new Promise(ok=>widget.chart(1).setSymbol('XAUUSD',ok)));
  await frame.waitForFunction(()=>widget.chart(1).getAllShapes().length===1);
  await frame.evaluate(id=>widget.chart(0).removeEntity(id),id);
  await frame.waitForFunction(()=>widget.chart(1).getAllShapes().length===0);
  await frame.waitForFunction(()=>!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy());
  await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
  await page.reload();
  await page.waitForTimeout(15000);
  const restored=page.frames().find(f=>f.url().startsWith('https://127.0.0.1:15444/'));
  await restored.waitForFunction(()=>ready&&!loading&&widget.chartsCount()===2&&widget.chart(0).dataReady()&&widget.chart(1).dataReady(),null,{timeout:60000});
  assert.deepEqual(await restored.evaluate(()=>[0,1].map(i=>widget.chart(i).getAllShapes().length)),[0,0]);
  await restored.evaluate(()=>new Promise(ok=>widget.chart(1).setResolution('60',ok)));
  assert.equal(await restored.evaluate(()=>widget.chart(1).getAllShapes().length),0);
  assert.deepEqual(errors,[]);
  console.log('DRAWING_ADD_EDIT_DELETE_RELOAD',{errors});
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
