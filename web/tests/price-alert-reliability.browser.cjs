// Real authentication, licensed chart, application API, market and notification runtimes.
const { chromium, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.resolve(process.env.MW_ALERT_ACCEPTANCE_CONFIG || "");
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (cfg.project !== "mw-price-alerts-v203rc1" || cfg.web_url !== "http://127.0.0.1:28463") {
  throw new Error("Use the private config of the isolated Ubuntu acceptance project");
}
const base = cfg.web_url;
const root = path.resolve(__dirname, "../..");
const output = path.join(path.dirname(configPath), "browser-result.json");
const scratch = path.join(path.dirname(configPath), "browser-command.json");
const report = { project: cfg.project, url: base, synthetic: true, checks: [] };

function fixture(operation, extra = []) {
  execFileSync(path.join(root, ".venv/bin/python"), [
    "scripts/price_alert_acceptance.py", operation, "--config", configPath, "--output", scratch, ...extra,
  ], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  return JSON.parse(fs.readFileSync(scratch, "utf8"));
}
const control = (change) => fixture("control", ["--set", JSON.stringify(change)]);
const evidence = (id) => fixture("evidence", ["--alert", id]);

async function request(page, uri, options) {
  const response = await page.request.fetch(base + uri, options);
  if (!response.ok()) throw new Error(uri + " returned " + response.status() + ": " + await response.text());
  return response.json();
}

async function authenticate(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(base + "/advanced-charts");
  await page.getByLabel("管理员密码").fill(cfg.admin_password);
  const [login] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/login")),
    page.getByRole("button", { name: /^登录并/ }).click(),
  ]);
  expect(login.status()).toBe(200);
  return { context, page };
}

async function nativeFrame(page) {
  await expect.poll(() => page.frames().filter((frame) => frame.url().startsWith("blob:")).length,
    { timeout: 45000 }).toBe(1);
  return page.frames().find((frame) => frame.url().startsWith("blob:"));
}

async function main() {
  const entries = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), "seed.json"))).entries;
  const composite = entries.EUR_USD.composite_id;
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  let id, context, page;
  try {
    control({ online: true, price: "99", prime_until: Date.now() + 180000 });
    ({ context, page } = await authenticate(browser));
    page.on("pageerror", (error) => errors.push(error.message));
    const items = await request(page, "/api/market-data/series/search?query=EURUSD&kind=composite");
    const selected = items.find((row) => row.id === composite);
    expect(selected).toBeTruthy();
    const initialSession = await request(page, "/api/session");
    const headers = { "X-CSRF-Token": initialSession.csrf };
    const workspace = await request(page, "/api/advanced-charts/workspaces", {
      method: "POST", headers, data: { name: "FIXTURE price alerts " + Date.now() },
    });
    await request(page, "/api/advanced-charts/workspaces/" + workspace.id + "/save", {
      method: "POST", headers, data: { name: workspace.name, revision: workspace.revision,
        document: { engine: "tv31", schemaVersion: 1, symbol: selected.ticker, interval: "1" } },
    });
    const chartUrl = "/advanced-charts/" + workspace.id;
    await page.goto(base + chartUrl);
    const frame = await nativeFrame(page);
    await frame.locator('button[data-name="alerts"]').click({ timeout: 45000 });
    await frame.getByRole("button", { name: "创建告警", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: /创建警报/ });
    await dialog.waitFor({ timeout: 30000 });
    await dialog.getByLabel("比较值", { exact: true }).fill("100");
    const options = dialog.locator("details.alert-advanced-options");
    if (await options.getAttribute("open") === null) await options.locator("summary").click();
    await options.getByText("收盘确认", { exact: true }).click();
    await frame.getByText("盘中观察", { exact: true }).last().click();
    await dialog.getByRole("button", { name: "触发次数", exact: true }).click();
    await frame.getByText("最多 3 次", { exact: true }).last().click();
    await expect(dialog.getByText(/未收到的价格无法补判/)).toBeVisible();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/chart-alerts") && r.request().method() === "POST"),
      dialog.getByRole("button", { name: "创建", exact: true }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(201);
    const row = await response.json();
    id = row.id;
    expect(row.execution.state).toBe("preparing");
    expect(row.market_identity.composite_revision_id).toBe(entries.EUR_USD.revision_id);
    const payload = response.request().postDataJSON();
    const session = await request(page, "/api/session");
    const replay = await request(page, "/api/chart-alerts", {
      method: "POST", data: payload, headers: { "X-CSRF-Token": session.csrf },
    });
    expect(replay.id).toBe(id);
    report.checks.push("A01: native chart form, immutable binding, preparing on create, HTTP replay returns one rule");

    const getRule = () => request(page, "/api/chart-alerts/" + id);
    await expect.poll(async () => (await getRule()).execution.state, { timeout: 15000 }).toBe("monitoring");
    await context.close();
    control({ prime_until: 0 });
    await expect.poll(() => evidence(id).unexpired_chart_leases, {
      timeout: 240000, intervals: [2500, 5000],
    }).toBe(0);
    expect(browser.contexts()).toHaveLength(0);
    control({ price: "101" });
    await expect.poll(() => evidence(id).count, { timeout: 12000 }).toBe(1);
    const signal = evidence(id).events[0];
    expect(Number(signal.price)).toBe(101);
    report.checks.push("A02: zero tabs and unexpired chart leases; live collector and runtime committed a signal");

    control({ price: "99" });
    await expect.poll(() => evidence(id).runtime.last_input_at, { timeout: 10000 }).toBeGreaterThan(signal.occurred_at);
    control({ online: false });
    await expect.poll(() => evidence(id).runtime.execution_state, { timeout: 12000 }).toBe("recovering");
    const fault = evidence(id).runtime.incident.id;
    expect(evidence(id).status).toBe("active");
    control({ online: true, price: "101" });
    await expect.poll(() => evidence(id).runtime.execution_state, { timeout: 18000 }).toBe("monitoring");
    const restored = evidence(id);
    expect(restored.count).toBe(1);
    expect(restored.runtime.last_incident.id).toBe(fault);
    expect(restored.runtime.last_gap.unrecoverable).toBe(true);
    report.checks.push("A09/A19: real disconnected lease, recovery baseline suppresses phantom crossing, gap retained");

    ({ context, page } = await authenticate(browser));
    page.on("pageerror", (error) => errors.push(error.message));
    const notices = async () => (await request(page,
      "/api/notification-center/events?audience=system&source=chart_alert_execution")).events
      .find((event) => event.context?.alert_id === id);
    await expect.poll(async () => (await notices())?.incident?.closed_at || null, { timeout: 12000 }).not.toBeNull();
    const notice = await notices();
    await page.goto(base + chartUrl + "?panel=notifications&event=" + encodeURIComponent(notice.id));
    const noteButton = page.getByRole("button", { name: "查看告警规则" });
    const native = await nativeFrame(page);
    if (await noteButton.isVisible()) await noteButton.click();
    else await native.getByRole("button", { name: "查看告警规则" }).click({ timeout: 20000 });
    const detail = native.getByRole("region", { name: "告警详情" });
    await expect(detail.getByText(/未能判定是否触发/)).toBeVisible({ timeout: 20000 });
    await expect(detail.getByText(/监控中/)).toBeVisible();
    await detail.getByRole("button", { name: "关闭详情" }).click();
    await native.getByRole("tab", { name: /^日志/ }).click();
    await expect(native.locator('[data-signal-id="' + signal.id + '"]')).toBeVisible();
    expect((await getRule()).id).toBe(id);
    expect(errors).toEqual([]);
    report.checks.push("A23: new browser session views projected recovery, follows rule link and reads historical signal");
    report.signal = signal;
    report.rule = id;
    report.passed = true;
  } finally {
    if (id) {
      const cleanup = await browser.newContext();
      try {
        const tab = await cleanup.newPage();
        const session = await request(tab, "/api/login", { method: "POST", data: { password: cfg.admin_password } });
        const row = await request(tab, "/api/chart-alerts/" + id);
        if (row.status === "active") await request(tab, "/api/chart-alerts/" + id + "/lifecycle", {
          method: "POST", headers: { "X-CSRF-Token": session.csrf },
          data: { request_id: randomUUID(), version: row.version, control_revision: row.control_revision, action: "pause" },
        });
      } finally {
        await cleanup.close();
      }
    }
    control({ prime_until: 0, price: "99", online: true });
    await browser.close();
  }
}

main().catch((error) => {
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }));
