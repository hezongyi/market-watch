const waitForAsync = require("./wait-for-async.cjs");
// Native watchlist section order survives server persistence and reload.
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
  const symbols=['###外汇与黄金','EURUSD','XAUUSD','###数字资产','BTCUSDT'];
  const listId=await frame.evaluate(async(symbols)=>{const w=await widget.watchList();const list=w.createList('分组保存验收',symbols);w.setActiveList(list.id);return list.id;},symbols);
  assert.ok(listId,"Native createList must return a valid ID");
  await waitForAsync(page, async({listId,symbols})=>{const prefs=await(await fetch('/api/advanced-charts/preferences')).json();const list=prefs.find(p=>p.name==='mw.watchlists.v1')?.content.value.lists.find(l=>l.id===listId);return JSON.stringify(list?.symbols)===JSON.stringify(symbols);},{listId,symbols});
  await page.reload();
  await page.waitForTimeout(15000);
  const restored=page.frames().find(f=>f.url().startsWith('https://127.0.0.1:15444/'));
  await restored.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  await restored.evaluate(async()=>(await widget.widgetbar()).showPage("watchlist_details_news"));
  await waitForAsync(restored, async()=>(await widget.watchList()).getAllLists()!==null);
  assert.deepEqual(await restored.evaluate(async(id)=>(await widget.watchList()).getList(id),listId),symbols);
  const native=restored.childFrames()[0];
  await native.getByText('外汇与黄金',{exact:true}).waitFor();
  await native.getByText('数字资产',{exact:true}).waitFor();
  await restored.evaluate(async(id)=>(await widget.watchList()).deleteList(id),listId);
  await waitForAsync(page, async(id)=>{const prefs=await(await fetch('/api/advanced-charts/preferences')).json();return !prefs.find(p=>p.name==='mw.watchlists.v1')?.content.value.lists.some(l=>l.id===id);},listId);
  assert.deepEqual(errors,[]);
  console.log('WATCHLIST_SECTIONS_RESTORED',{symbols,errors});
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
