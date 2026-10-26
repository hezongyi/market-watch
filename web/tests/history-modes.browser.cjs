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
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.on("pageerror", e => report.errors.push(e.message));
  let csrf;
  const api = async (route, data) => {
    const response = data === undefined
      ? await page.request.get(base + "/api" + route)
      : await page.request.post(base + "/api" + route, {data, headers: {"X-CSRF-Token": csrf}});
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
    await page.goto(`${base}/advanced-charts/${encodeURIComponent(workspace.id)}`);
    await expect.poll(() => !!host() && !!native(), {timeout: 60000}).toBe(true);
    await host().waitForFunction(() => ready && dataCenter, null, {timeout: 60000});
    for (const item of cases) {
      const input = item.mode === "base_d1" ? ["D1"] : item.frames;
      if (process.env.MW_HISTORY_MODES_SKIP_PROBE !== "1") {
        const probe = await api("/market-data/history-catalog/probe", {
          source: item.source, provider_symbol: item.symbol, adjustment: "none", timeframes: input,
          start: Date.parse(item.start + "T00:00:00Z")});
        expect(input.every(frame => probe.frames.includes(frame))).toBe(true);
      }
      await open(`/market-data/datasets/new?source=${encodeURIComponent(item.source)}&symbol=${encodeURIComponent(item.symbol)}`);
      const configure = window().getByRole("button", {name: "配置历史 →", exact: true});
      if (await configure.count()) {
        await expect(configure).toBeEnabled({timeout: 30000});
        await configure.click();
      }
      await select("维护模式", item.mode === "base_d1" ? "D1 基础派生" : "原生多周期");
      await window().getByLabel("起始交易日期", {exact: true}).fill(item.start);
      const choices = window().locator("fieldset").filter({has: native().locator("legend", {hasText: "需要的周期"})});
      for (const check of await choices.getByRole("checkbox").all()) {
        const label = await check.getAttribute("aria-label");
        await check.setChecked(item.frames.includes(label));
      }
      expect(await choices.getByRole("checkbox", {name: "M1", exact: true}).count()).toBe(0);
      const responsePromise = page.waitForResponse(r => r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/market-data/center/datasets", {timeout: 60000});
      await window().getByRole("button", {name: "创建并开始准备历史", exact: true}).click();
      const created = await responsePromise;
      expect(created.status()).toBe(201);
      const {dataset, task} = await created.json();
      await expect(window().getByText("自建行情已创建，历史准备任务已提交", {exact: true})).toBeVisible();
      const record = {source: item.source, symbol: item.symbol, mode: item.mode,
        dataset_id: dataset.id, version_id: task.id, requested: item.frames};
      report.cases.push(record);
      await expect.poll(async () => {
        const version = await api(`/market-data/versions/${task.id}`);
        if (["failed", "cancelled"].includes(version.status)) throw Error(`Archive terminated: ${version.status}`);
        const detail = await api(`/market-data/center/datasets/${dataset.id}`);
        return !detail.maintenance.active_version_id && item.frames.every(frame => detail.usable_timeframes.includes(frame));
      }, {timeout: Number(process.env.MW_HISTORY_MODES_TIMEOUT_MS || 300000), intervals: [1000, 2000, 5000]}).toBe(true);
      const detail = await api(`/market-data/center/datasets/${dataset.id}`);
      record.periods = detail.periods.map(p => ({timeframe: p.timeframe, rows: p.available_rows,
        start: p.available_start, end: p.available_end, freshness: p.freshness}));
      expect(detail.usable_timeframes.includes("M1")).toBe(false);
      const requests = await api(`/market-data/versions/${task.id}/requests?page_size=100`);
      record.request_count = requests.total;
      expect(requests.total).toBeGreaterThan(0);
      expect(requests.items.every(row => input.includes(row.timeframe))).toBe(true);
      await window().getByRole("link", {name: "管理行情", exact: true}).click();
      await expect(window().getByRole("table", {name: "实际周期产物"})).toBeVisible();
      await page.screenshot({path: path.join(out, `${report.cases.length}-${item.mode}.png`)});
      const chart = await api(`/market-data/versions/${task.id}/chart?timeframe=${input[0]}&count=100`);
      expect(chart.bars.length).toBeGreaterThan(0);
      record.chart_bars = chart.bars.length;
      record.passed = true;
      await native().getByRole("button", {name: "关闭数据中心", exact: true}).click();
    }
    report.checks.push("Real UI creates D1/native histories; independent artifacts, no M1 requests, task completes and chart reads");
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
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
