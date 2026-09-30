// Three-chart nested splitters retain both dimensions across server save/reload.
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
  await frame.evaluate(()=>widget.setLayout('3s'));
  await frame.waitForFunction(()=>widget.chartsCount()===3 && [0,1,2].every(i=>widget.chart(i).dataReady()) && !edgeGuard.busy() && !rangeGuard.busy());
  const dimensions=()=>frame.evaluate(()=>[0,1,2].map(i=>({width:widget.chart(i).getTimeScale().width(),height:widget.chart(i).getAllPanesHeight().reduce((a,b)=>a+b,0)})));
  const before=await dimensions();
  const handles=ui.locator('[class*="chart-widget-collection-border--"]');
  const boxes=await Promise.all((await handles.all()).map(h=>h.boundingBox()));
  console.log('SPLITTERS',JSON.stringify(boxes));
  const vertical=boxes.find(b=>b && b.height>200 && b.width<30);
  assert.ok(vertical,'vertical splitter');
  await page.mouse.move(vertical.x+vertical.width/2,vertical.y+vertical.height/2);
  await page.mouse.down();
  await page.mouse.move(vertical.x+vertical.width/2+100,vertical.y+vertical.height/2,{steps:12});
  await page.mouse.up();
  await frame.waitForFunction(w=>widget.chart(0).getTimeScale().width()>w+70,before[0].width);
  const nextBoxes=await Promise.all((await handles.all()).map(h=>h.boundingBox()));
  const horizontal=nextBoxes.find(b=>b && b.width>200 && b.height<30);
  assert.ok(horizontal,'horizontal splitter');
  await page.mouse.move(horizontal.x+horizontal.width/2,horizontal.y+horizontal.height/2);
  await page.mouse.down();
  await page.mouse.move(horizontal.x+horizontal.width/2,horizontal.y+horizontal.height/2+70,{steps:12});
  await page.mouse.up();
  await frame.waitForFunction(h=>widget.chart(1).getAllPanesHeight().reduce((a,b)=>a+b,0)>h+40,before[1].height);
  const resized=await dimensions();
  await frame.waitForFunction(()=>!nativeSaving && !rangeGuard.busy() && !edgeGuard.busy());
  await frame.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
  await page.reload();
  await page.waitForTimeout(15000);
  const restoredFrame=page.frames().find(f=>f.url().startsWith('https://127.0.0.1:15444/'));
  await restoredFrame.waitForFunction(()=>ready && !loading && widget.chartsCount()===3 && [0,1,2].every(i=>widget.chart(i).dataReady()) && !rangeGuard.busy() && !edgeGuard.busy());
  // Native dataReady precedes the final layout pass; wait for saved geometry too.
  await restoredFrame.waitForFunction(expected=>[0,1,2].every(i=>{
    const c=widget.chart(i);
    return Math.abs(c.getTimeScale().width()-expected[i].width)<=2 && Math.abs(c.getAllPanesHeight().reduce((a,b)=>a+b,0)-expected[i].height)<=2;
  }),resized);
  const restored=await restoredFrame.evaluate(()=>[0,1,2].map(i=>({width:widget.chart(i).getTimeScale().width(),height:widget.chart(i).getAllPanesHeight().reduce((a,b)=>a+b,0)})));
  console.log('RESTORED_NOTICES',await page.locator('[role=alert], [role=status]').allTextContents());
  await page.screenshot({path:'/tmp/mw-three-layout-resize.png'});
  for(let i=0;i<3;i++) for(const axis of ['width','height']) assert.ok(Math.abs(resized[i][axis]-restored[i][axis])<=2,JSON.stringify({i,axis,resized,restored}));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/mw-three-layout-resize.png'});
  console.log('THREE_LAYOUT_RESIZE_RESTORE',JSON.stringify({before,resized,restored,errors}));
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
