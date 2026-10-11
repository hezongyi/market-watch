// Full AdvancedWorkspace + shipped host, actual licensed widget, synthetic API.
// In-process browser routes only: no deployed application or production access.
const { chromium } = require("@playwright/test");
const { build } = require("esbuild");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.."),
  library = process.env.MW_PROBE_LIBRARY;
const output =
  process.env.MW_WORKSPACE_OUTPUT || "/tmp/mw-native-alert-workspace";
if (!library) throw Error("MW_PROBE_LIBRARY must identify the private library");
const APP = "https://workspace-parent.invalid",
  CHART = "https://workspace-chart.invalid";
const a = {
  id: "workspace-a",
  name: "工作区 A",
  revision: 1,
  document: {
    engine: "tv31",
    schemaVersion: 1,
    symbol: "MWP:EURUSD",
    interval: "60",
  },
};
const workspaces = [a],
  rows = [],
  errors = [],
  requests = [],
  messages = [],
  unexpected = [];
let delayedRead,
  releaseRead,
  conflict = false;
function history(q) {
  const step = 3600000,
    end = Math.floor((q.before || Date.now()) / step) * step;
  const count = Math.min(q.countBack || q.limit || 400, 2000);
  const bars = Array.from({ length: count }, (_, i) => {
    const start = end - (count - i) * step,
      close = 1.12 + Math.sin(start / step / 5) * 0.003;
    return {
      start,
      end: start + step,
      chart_time: start,
      open: String(close - 0.0003),
      high: String(close + 0.001),
      low: String(close - 0.001),
      close: String(close),
      complete: true,
      volume: null,
      revision: 1,
    };
  });
  return {
    bars,
    indicators: [],
    has_more: true,
    cache_revision: 1,
    as_of: Date.now(),
    calculation_origin: bars[0].start,
  };
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const uiAssets = path.join(output, "ui-assets");
  execFileSync(process.execPath, ["scripts/build-alert-ui.mjs", uiAssets], {
    cwd: path.join(root, "web"),
  });
  // Apply the existing production build hook to a disposable copy only.
  const patched = path.join(output, "library.e2f8b3a016c9e1a0b7a5.js");
  fs.copyFileSync(
    path.join(library, "bundles", path.basename(patched)),
    patched,
  );
  execFileSync(process.execPath, [
    path.join(root, "advanced-host/patch-native-reserve.mjs"),
    patched,
  ]);
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import AdvancedWorkspace from './src/advanced/AdvancedWorkspace';import {setCsrf} from './src/api';setCsrf('parent-only-fixture');createRoot(document.getElementById('root')).render(<AdvancedWorkspace/>);`,
      loader: "tsx",
      resolveDir: path.join(root, "web"),
    },
    bundle: true,
    write: false,
    outdir: "fixture",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": JSON.stringify({ VITE_ADVANCED_CHART_ORIGIN: CHART }),
    },
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
  });
  const report = {
    scope:
      "Ubuntu Chromium; full AdvancedWorkspace and shipped bridge with actual licensed widget; routed synthetic API; no deployed instance",
    cases: [],
    passed: false,
  };
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() =>
    addEventListener("message", (e) => {
      if (e.data?.channel === "mw-chart-v1")
        (globalThis.__messages ||= []).push(e.data);
    }),
  );
  await page.route(APP + "/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      body = req.method() === "POST" ? req.postDataJSON() : undefined;
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    if (url.pathname.startsWith("/fixture.")) {
      const f = bundle.outputFiles.find((f) =>
        f.path.endsWith(path.extname(url.pathname)),
      );
      return route.fulfill({
        body: f.text,
        contentType: url.pathname.endsWith(".js")
          ? "text/javascript"
          : "text/css",
      });
    }
    requests.push({
      path: url.pathname,
      body,
      csrf: req.headers()["x-csrf-token"],
    });
    if (url.pathname === "/readyz") return reply({ time: Date.now() });
    if (url.pathname === "/api/advanced-charts/workspaces")
      return reply(workspaces);
    if (url.pathname === "/api/advanced-charts/native-charts")
      return reply(
        workspaces.map((w) => ({
          ...w,
          symbol: w.document.symbol,
          resolution: w.document.interval,
          timestamp: Date.now() / 1000,
          content: JSON.stringify(w.document.state),
        })),
      );
    if (url.pathname === "/api/advanced-charts/native-charts/save") {
      let row = workspaces.find((w) => w.id === body.id);
      if (!row) {
        row = {
          id: "workspace-" + workspaces.length,
          name: body.name,
          revision: 0,
          document: {},
        };
        workspaces.push(row);
      }
      row.name = body.name;
      row.revision++;
      row.document = {
        engine: "tv31",
        schemaVersion: 1,
        symbol: body.symbol,
        interval: body.resolution,
        state: JSON.parse(body.content),
      };
      return reply({ ...row, content: body.content });
    }
    if (url.pathname.startsWith("/api/advanced-charts/native-charts/")) {
      const row = workspaces.find(
        (w) => w.id === url.pathname.split("/").at(-1),
      );
      return reply({ ...row, content: JSON.stringify(row.document.state) });
    }
    if (url.pathname === "/api/advanced-charts/catalog") return reply({});
    if (url.pathname === "/api/advanced-charts/preferences") return reply([]);
    if (url.pathname === "/api/advanced-charts/preferences/migrate")
      return reply({ ok: true });
    if (url.pathname === "/api/advanced-charts/preferences/save")
      return reply({
        ...body,
        id: "f".repeat(64),
        revision: body.revision + 1,
      });
    if (url.pathname === "/api/charts/history-capabilities")
      return reply({
        protocol: 1,
        version: "fixture",
        mode: "continuous",
        max_bars: 20000,
        workspace_bars: 40000,
        response_bytes: 8000000,
        task_seconds: 30,
        min_bars: 100,
        hard_max_bars: 20000,
        default_bars: 4000,
      });
    if (url.pathname === "/api/market-data/resolve")
      return reply({
        instrument: body.instrument,
        symbol: body.instrument,
        name: body.instrument,
        source: "fixture",
        basis: "last",
        calendar: "utc0",
        precision: 5,
        session: "24x7",
        timezone: "Etc/UTC",
        frames: ["H1"],
        volume_kind: "unavailable",
      });
    if (url.pathname === "/api/market-data/quotes")
      return reply(
        body.symbols.map((n) => ({
          n,
          s: "ok",
          v: { lp: 1.12, ch: 0, chp: 0, short_name: n, exchange: "Fixture" },
        })),
      );
    if (url.pathname === "/api/charts/history-loads")
      return reply({ result: history(body.query) });
    if (url.pathname === "/api/charts/data") return reply(history(body));
    if (url.pathname === "/api/charts/reserve")
      return reply({ ...history(body), reserve_status: "ready" });
    if (["/api/charts/provider/subscribe", "/api/charts/stream/subscribe"].includes(url.pathname))
      return reply({ listener: crypto.randomUUID() });
    if (["/api/charts/provider/unsubscribe", "/api/charts/stream/unsubscribe"].includes(url.pathname))
      return reply({ ok: true });
    if (["/api/charts/provider/events", "/api/charts/stream/events"].includes(url.pathname))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": fixture\n\n",
      });
    if (url.pathname === "/api/chart-alerts/capabilities")
      return reply({
        sources: [
          {
            source: "fixture",
            series_kind: "provider",
            basis: "last",
            available: true,
            observation_basis: "fixture",
          },
        ],
        modes: ["close", "intrabar"],
      });
    if (url.pathname === "/api/chart-alerts/events") return reply([]);
    if (url.pathname === "/api/chart-alerts" && req.method() === "GET") {
      if (delayedRead) {
        const response = delayedRead;
        delayedRead = null;
        await new Promise((resolve) => (releaseRead = resolve));
        return reply(response);
      }
      return reply(rows);
    }
    if (url.pathname === "/api/chart-alerts") {
      const row = {
        id: crypto.randomUUID(),
        name: body.config.name,
        config: body.config,
        status: "active",
        health: "ready",
        version: 1,
        control_revision: 1,
        count: 0,
        max_triggers: body.config.max_triggers,
        effective_at: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
        condition_summary: "价格 上穿 " + body.config.condition.right?.value,
      };
      rows.push(row);
      return reply(row, 201);
    }
    if (url.pathname.endsWith("/edit")) {
      if (conflict) {
        conflict = false;
        return reply({ detail: "告警版本冲突，请核对后重试" }, 409);
      }
      const row = rows.find((row) => row.id === url.pathname.split("/")[3]);
      row.config = body.config;
      row.name = body.config.name;
      row.version++;
      return reply(row);
    }
    unexpected.push(url.pathname);
    return reply({ detail: "Unexpected fixture path " + url.pathname }, 404);
  });
  await page.route(CHART + "/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: fs.readFileSync(
          path.join(root, "advanced-host/index.html"),
          "utf8",
        ),
      });
    const relative = decodeURIComponent(url.pathname).slice(1);
    const file =
      relative === "charting_library/bundles/" + path.basename(patched)
        ? patched
        : relative.startsWith("charting_library/")
          ? path.join(library, relative.slice("charting_library/".length))
          : /^alert-ui\.(js|css)$/.test(relative)
            ? path.join(uiAssets, relative)
            : path.join(root, "advanced-host", relative);
    if (!fs.existsSync(file)) {
      unexpected.push(url.pathname);
      return route.fulfill({ status: 404, body: "Missing fixture asset" });
    }
    return route.fulfill({
      path: file,
      ...(file.endsWith(".js")
        ? { contentType: "text/javascript; charset=utf-8" }
        : file.endsWith(".css")
          ? { contentType: "text/css" }
          : {}),
    });
  });
  try {
    await page.goto(APP + "/");
    const iframe = page.locator('iframe[title="专业图表工作区"]');
    await iframe.waitFor();
    await page
      .frameLocator('iframe[title="专业图表工作区"]')
      .locator("#chart")
      .waitFor();
    const host = page.frames().find((f) => f.url().startsWith(CHART + "/"));
    const settle = async () =>
      host.waitForFunction(
        () =>
          ready &&
          !loading &&
          alertUI &&
          widget.activeChart().dataReady() &&
          !nativeSaving &&
          !dirty,
        null,
        { timeout: 60000 },
      );
    await settle();
    const chart = host.childFrames()[0];
    const dialog = chart.locator('[data-name="mw-native-alert-dialog"]');
    await host.evaluate(() => alertUI.open());
    await chart
      .getByRole("button", { name: "创建告警", exact: true })
      .first()
      .click();
    await dialog.waitFor();
    await dialog.getByLabel("比较值", { exact: true }).fill("1.125");
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    await dialog.getByLabel("警报名称").fill("工作区 A 的草稿");
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("mw-chart-alert-draft:workspace-a"))
          ?.config.name === "工作区 A 的草稿",
    );
    const oldSession = await host.evaluate(() => alertUISession);
    report.cases.push(
      "Full shipped host opens native dialog through validated parent context; draft resides in parent localStorage",
    );
    // Save As uses the native adapter. No iframe replacement or timing shortcut.
    await chart.getByRole("button", { name: "管理布局", exact: true }).click();
    await chart.getByText("复制…", { exact: true }).click();
    await chart.getByRole("textbox").fill("工作区 B");
    await chart.getByRole("button", { name: "复制", exact: true }).click();
    await host.waitForFunction(
      () => alertUIWorkspace !== "workspace-a" && alertUI && !loading,
    );
    const bId = await iframe.getAttribute("data-workspace-id");
    assert.notEqual(bId, a.id);
    assert.equal(host.isDetached(), false);
    assert.notEqual(await host.evaluate(() => alertUISession), oldSession);
    await host.evaluate(() => alertUI.open());
    await chart
      .getByRole("button", { name: "创建告警", exact: true })
      .first()
      .click();
    await dialog.waitFor();
    await dialog.getByLabel("比较值", { exact: true }).fill("1.13");
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(rows[0].config.association.workspace_id, bId);
    report.cases.push(
      "Native Save As binds a fresh UI session and correctly scoped API; old workspace draft remains available",
    );
    // Put an old list result in flight, then load A through the native server loader.
    delayedRead = [{ ...rows[0], name: "不得出现的旧响应" }];
    await chart.getByRole("button", { name: "更多选项", exact: true }).click();
    await chart.getByRole("menuitem", { name: "刷新", exact: true }).click();
    for (let i = 0; !releaseRead && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(releaseRead, "old refresh must be in flight before switching");
    await host.evaluate(async (a) => {
      await widget.loadChartFromServer({
        id: a.id,
        name: a.name,
        image_url: "",
        modified_iso: Date.now() / 1000,
        short_symbol: "MWP:EURUSD",
        interval: "60",
      });
    }, a);
    releaseRead();
    await settle();
    assert.equal(await iframe.getAttribute("data-workspace-id"), a.id);
    await host.evaluate(() => alertUI.open());
    await chart.getByRole("button", { name: "更多选项", exact: true }).click();
    await chart
      .getByRole("menuitem", { name: "恢复草稿", exact: true })
      .click();
    await dialog.waitFor();
    assert.equal(
      await dialog.getByLabel("比较值", { exact: true }).inputValue(),
      "1.125",
    );
    await dialog.getByRole("button", { name: "消息", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("警报名称").inputValue(),
      "工作区 A 的草稿",
    );
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(rows[1].config.association.workspace_id, a.id);
    assert.equal(
      await chart.getByText("不得出现的旧响应", { exact: true }).count(),
      0,
    );
    assert.equal(await host.locator('[data-name="mw-alert-state"]').count(), 1);
    report.cases.push(
      "Native layout load restores A draft, rejects late B response, retains one renderer and keeps iframe alive",
    );
    conflict = true;
    await chart
      .locator(".chart-alert-card")
      .filter({ hasText: "工作区 A 的草稿" })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await dialog.waitFor();
    await dialog.getByLabel("比较值", { exact: true }).fill("1.14");
    await dialog.getByRole("button", { name: "保存新版本" }).click();
    await dialog.getByRole("alert").filter({ hasText: "版本冲突" }).waitFor();
    assert.equal(
      await dialog.getByLabel("比较值", { exact: true }).inputValue(),
      "1.14",
    );
    await page.screenshot({ path: path.join(output, "conflict.png") });
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    report.cases.push(
      "Version conflict preserves edited input and exposes native-window feedback",
    );
    await page.screenshot({ path: path.join(output, "workspace.png") });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.ok(
      requests
        .filter((r) => r.body && r.path.startsWith("/api/chart-alerts"))
        .every((r) => r.csrf === "parent-only-fixture"),
    );
    report.passed = true;
  } catch (error) {
    report.failure = String(error);
    await page.screenshot({ path: path.join(output, "failure.png") });
    process.exitCode = 1;
  } finally {
    report.errors = errors;
    report.unexpected = unexpected;
    report.messages = await page.evaluate(() =>
      globalThis.__messages?.map((m) => ({
        type: m.type,
        workspace_id: m.workspace_id,
        error: m.error,
      })),
    );
    report.requests = requests.map(({ path, body }) => ({ path, body }));
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          passed: report.passed,
          cases: report.cases,
          failure: report.failure,
          errors,
          unexpected,
        },
        null,
        2,
      ),
    );
    await browser.close();
  }
})();
