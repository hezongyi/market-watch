// Run only after the operator approves mw-acceptance. No deployment or data reset.
const fs = require("node:fs");
const path = require("node:path");
const {chromium, expect} = require("@playwright/test");
const required = name => {
  if (!process.env[name]) throw Error(`Required environment variable: ${name}`);
  return process.env[name];
};
const base = new URL(required("MW_HISTORY_MODES_BASE_URL")).origin;
const auth = JSON.parse(fs.readFileSync(required("MW_HISTORY_MODES_AUTH_FILE"), "utf8"));
const out = path.resolve(process.env.MW_HISTORY_MODES_OUTPUT || "artifacts/history-modes");
const cases = process.env.MW_HISTORY_MODES_CASES_FILE
  ? JSON.parse(fs.readFileSync(process.env.MW_HISTORY_MODES_CASES_FILE, "utf8"))
  : [
    {source: "akshare", symbol: "SZSE:000001", mode: "base_d1", start: "2026-01-01", frames: ["D1", "W1", "MN"]},
    {source: "akshare", symbol: "SHFE:RB0", mode: "native_periods", start: "2026-09-01", frames: ["M5", "D1"]},
  ];
const report = {started_at: new Date().toISOString(), base, passed: false,
  scope: "Deployed real API and native UI; no intercepted data, no source price repair; preserves all created data",
  checks: [], cases: [], errors: []};
fs.mkdirSync(out, {recursive: true});

(async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}),
    args: ["--no-sandbox"]});
  const context = await browser.newContext({ignoreHTTPSErrors: false, viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.on("pageerror", e => report.errors.push(e.message));
  report.console = []; report.network_errors = [];
  page.on("console", m => { if(m.type() === "error") report.console.push(m.text().split("\n")[0].slice(0,300)); });
  page.on("response", r => {if(r.status() >= 400 && new URL(r.url()).pathname.startsWith("/api/")) report.network_errors.push({status:r.status(),path:new URL(r.url()).pathname});});
  // Protect pre-existing user preferences and native chart documents. APIRequestContext
  // creates a fresh task workspace; market data and dataset commands remain real.
  report.blocked_writes = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), u = new URL(request.url());
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
        /\/api\/(?:charts|advanced-charts)\/(?:workspaces|native-charts|preferences)/.test(u.pathname)) {
      const safeBody = request.postDataJSON() || {};
      if (report.workspace_id && (safeBody.id === report.workspace_id || u.pathname.includes("/workspaces/" + report.workspace_id + "/"))) { await route.continue(); return; }
      report.blocked_writes.push({method: request.method(), path: u.pathname});
      const body = request.postDataJSON() || {};
      const response = u.pathname.endsWith("/preferences/save")
        ? {...body, id: require("node:crypto").createHash("sha256").update(JSON.stringify([body.kind, body.name, body.tool || ""])).digest("hex"), revision: (body.revision || 0) + 1}
        : {ok: true};
      await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(response)});
      return;
    }
    await route.continue();
  });
  let csrf;
  const api = async (route, data) => {
    const response = data === undefined
      ? await page.request.get(base + "/api" + route)
      : await page.request.post(base + "/api" + route, {data, headers: {"X-CSRF-Token": csrf}, timeout: 90000});
    if (!response.ok()) throw Error(`HTTP ${response.status()} ${route}`);
    return response.json();
  };
  const host = () => page.frames().find(f => {
    try {const u = new URL(f.url()); return u.pathname === "/" && u.searchParams.has("parent");} catch {return false;}
  });
  const native = () => page.frames().find(f => f.url().startsWith("blob:"));
  const window = () => native().locator(".dc-window");
  const open = async route => {
    await host().evaluate(route => dataCenter.open(route), route);
    await expect(window()).toBeVisible();
  };
  const select = async (label, option) => {
    await window().getByRole("button", {name: label, exact: true}).click();
    await native().getByRole("option", {name: option, exact: true}).click();
  };
  try {
    const login = await page.request.post(base + "/api/login", {data: auth});
    if (!login.ok()) throw Error(`Login failed: HTTP ${login.status()}`);
    csrf = (await api("/session")).csrf;
    const workspace = await api("/advanced-charts/workspaces", {name: "历史模式验收 " + report.started_at});
    report.workspace_id = workspace.id;
    await api("/advanced-charts/workspaces/" + workspace.id + "/save", {name:workspace.name, revision:workspace.revision,
      document:{...workspace.document, symbol:"MWH:4c5f2cb9-d7b6-44e3-9b2c-91f1ccd29170", series_kind:"history", interval:"1D"}});
    await page.goto(`${base}/advanced-charts/${encodeURIComponent(workspace.id)}`);
    await expect.poll(() => !!host() && !!native(), {timeout: 60000}).toBe(true);
    await host().waitForFunction(() => ready && dataCenter, null, {timeout: 60000});
    for (const [name, version] of [["sina-a", "4c5f2cb9-d7b6-44e3-9b2c-91f1ccd29170"], ["sina-hk", "a0f00e6e-b3ae-466d-abb0-1f27358da78d"], ["yahoo-us", "731e970b-5166-4d7e-a521-b707784c7e50"]]) {
      console.log("Render managed", name);
      const ticker = "MWH:" + version;
      await host().evaluate(() => { void widget.activeChart().setResolution("1D", {doNotActivateChart: true}); });
      await host().waitForFunction(() => widget.activeChart().resolution() === "1D" && widget.activeChart().dataReady(), null, {timeout: 60000});
      await host().evaluate(ticker => { void widget.activeChart().setSymbol(ticker, {doNotActivateChart: true}); }, ticker);
      await host().waitForFunction(ticker => widget.activeChart().symbol().toLowerCase() === ticker.toLowerCase() && widget.activeChart().dataReady() && widget.activeChart().getVisibleRange()?.to > widget.activeChart().getVisibleRange()?.from, ticker, {timeout: 90000});
      const rendered = await host().evaluate(() => ({symbol: widget.activeChart().symbol(), ready: widget.activeChart().dataReady(), range: widget.activeChart().getVisibleRange()}));
      const meta = await api("/market-data/resolve", {instrument: version, series_kind: "history", timeframe: "D1"});
      expect(meta.adjustment_view).toBe("qfq");
      const ui = await native().locator("body").innerText();
      expect(ui).toContain("前复权");
      report.cases.push({name, version, rendered, adjustment_view: meta.adjustment_view, ui: ui.slice(0,6000), passed:true});
      fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
      await page.screenshot({path: path.join(out, name + ".png")});
    }
    const yahooDataset = "1de909844cec998226e338b48542e7d9b4176b4a7016065426488f77a8d9c72c";
    const detail = await api("/market-data/center/datasets/" + yahooDataset);
    expect(detail.usable_timeframes).toContain("D1");
    expect(detail.usable_timeframes).not.toContain("M1");
    await open("/market-data/datasets/" + yahooDataset);
    await expect(window().getByRole("table", {name: "实际周期产物"})).toBeVisible({timeout: 30000});
    report.yahoo_detail = {dataset_id: yahooDataset, usable_timeframes: detail.usable_timeframes, ui: await window().innerText()};
    await page.screenshot({path: path.join(out, "yahoo-detail.png")});
    report.checks.push("Managed Sina A/H and Yahoo charts render real qfq daily candles; Yahoo dataset detail shows usable daily artifact");
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message.split("\n")[0]);
    report.failure_state = await host()?.evaluate(() => ({symbol: widget.activeChart().symbol(),resolution: widget.activeChart().resolution(),ready: widget.activeChart().dataReady()})).catch(()=>null);
    report.failure_ui = await native()?.locator("body").innerText().catch(()=>null);
    await page.screenshot({path: path.join(out, "failure.png")}).catch(() => {});
    process.exitCode = 1;
  } finally {
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    await context.close();
    await browser.close();
    console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, output: out}));
  }
})();
