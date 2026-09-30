const waitForAsync = require("./wait-for-async.cjs");
// Native manual-save rejection must remain readable and pending edits must auto-save.
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
  await frame.waitForFunction(()=>!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy());
  await frame.evaluate(()=>{
    globalThis.originalBusy=rangeGuard.busy;
    rangeGuard.busy=()=>true;
  });
  const id=await frame.evaluate(async()=>{
    const c=widget.activeChart();
    return c.createShape({time:1790323200,price:4333.21},{shape:'horizontal_line'});
  });
  await ui.locator('[data-name="save-load-menu"]').click();
  await ui.getByText("保存布局",{exact:true}).click();
  await ui.getByText(/图表正在切换，数据就绪后自动保存/).waitFor({timeout:10000});
  await ui.getByRole("button",{name:"确认",exact:true}).click();
  const failure=await frame.evaluate(()=>new Promise(resolve=>widget.saveChartToServer(()=>resolve('unexpected success'),e=>resolve(String(e?.message||e)))));
  assert.match(failure,/图表正在切换/);
  assert.equal(await frame.evaluate(()=>dirty),true);
  await frame.evaluate(()=>{rangeGuard.busy=originalBusy;});
  await waitForAsync(page, async(id)=>{
    const rows=await(await fetch('/api/advanced-charts/workspaces')).json();
    return rows.some(r=>JSON.stringify(r.document).includes(id));
  },id,{timeout:30000});
  assert.deepEqual(errors,[]);
  console.log('BUSY_SAVE_RETRIES',{failure,id,errors});
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
