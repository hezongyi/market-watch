// Public native study pane operations and visibility persist across reload.
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
  const id=await frame.evaluate(()=>widget.activeChart().createStudy('Moving Average',false,false,{length:21}));
  assert.ok(id);
  const state=()=>frame.evaluate(id=>{const c=widget.activeChart(),s=c.getStudyById(id);return {panes:c.getPanes().length,index:s.paneIndex(),visible:s.isVisible()};},id);
  assert.deepEqual(await state(),{panes:1,index:0,visible:true});
  await frame.evaluate(id=>widget.activeChart().getStudyById(id).unmergeDown(),id);
  await frame.waitForFunction(()=>widget.activeChart().getPanes().length===2);
  assert.deepEqual(await state(),{panes:2,index:1,visible:true});
  await frame.evaluate(id=>widget.activeChart().getStudyById(id).mergeUp(),id);
  await frame.waitForFunction(()=>widget.activeChart().getPanes().length===1);
  assert.deepEqual(await state(),{panes:1,index:0,visible:true});
  await frame.evaluate(id=>{const s=widget.activeChart().getStudyById(id);s.unmergeDown();s.setVisible(false);},id);
  assert.deepEqual(await state(),{panes:2,index:1,visible:false});
  await frame.waitForFunction(()=>!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy());
  await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
  await page.reload();
  await page.waitForTimeout(15000);
  const restored=page.frames().find(f=>f.url().startsWith('https://127.0.0.1:15444/'));
  await restored.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  const saved=await restored.evaluate(()=>{const c=widget.activeChart(),items=c.getAllStudies();return items.map(item=>{const s=c.getStudyById(item.id);return {id:item.id,index:s.paneIndex(),visible:s.isVisible(),inputs:s.getInputValues()};});});
  assert.equal(saved.length,1);
  assert.equal(saved[0].index,1);
  assert.equal(saved[0].visible,false);
  assert.equal(saved[0].inputs.find(i=>i.id==='length').value,21);
  await restored.evaluate(id=>widget.activeChart().getStudyById(id).setVisible(true),saved[0].id);
  assert.equal(await restored.evaluate(id=>widget.activeChart().getStudyById(id).isVisible(),saved[0].id),true);
  assert.deepEqual(errors,[]);
  console.log('INDICATOR_PANE_VISIBILITY_RESTORED',{saved,errors});
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
