// Real production build + explicit HTTP fixture; never presented as a supplier/device test.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { chromium, expect } = require("@playwright/test");
const out = process.env.MOBILE_DATA_OUTPUT || "/tmp/mw-mobile-data-workflow",
  dist = path.resolve("dist");
fs.mkdirSync(out, { recursive: true });
const eid = "c".repeat(64),
  gid = "d".repeat(64),
  yid = "e".repeat(64),
  nativeId = "f".repeat(64),
  mid = "a".repeat(64),
  cid = "b".repeat(64),
  vid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = Date.now(),
  start = now - 30 * 86400000;
const entries = [
  {
    catalog_id: "HC:EUR_USD",
    source: "dukascopy",
    provider_symbol: "EUR/USD",
    logical_symbol: "EURUSD",
    display_symbol: "EURUSD",
    label: "欧元美元",
    asset_class: "forex",
    precision: 5,
  },
  {
    catalog_id: "HC:XAU_USD",
    source: "dukascopy",
    provider_symbol: "XAU/USD",
    logical_symbol: "XAUUSD",
    display_symbol: "XAUUSD",
    label: "黄金",
    asset_class: "metal",
    precision: 3,
  },
  {
    catalog_id: "HC:AAPL",
    source: "yahoo",
    provider_symbol: "AAPL",
    logical_symbol: "YAPP001",
    display_symbol: "AAPL",
    label: "苹果",
    asset_class: "equity",
    precision: 2,
    default_mode: "base_d1",
    supported_modes: ["base_d1", "native_periods"],
    supported_frames: { none: ["D1", "H1"] },
    verified_frames: {},
    default_start_date: "2020-01-01",
    timezone: "America/New_York",
  },
];
const datasets = new Map(),
  tasks = new Map(),
  mappings = new Map();
let logged = false,
  createLost = true,
  mappingLost = false,
  enableLost = false,
  failEnable = false,
  conflict = false,
  failProbe = false,
  hideExisting = false,
  missingBaseline = false,
  livePrepared = true,
  defaultOverride = "",
  rolloverOverride = null;
let remote = {
  kind: "setting",
  name: "mw.watchlists.v1",
  tool: "",
  revision: 1,
  content: {
    envelope: "keep",
    value: {
      active: "desktop",
      unknown: "keep",
      lists: [{ id: "g", title: "主要观察", symbols: [] }],
    },
  },
};
const writes = [],
  errors = [],
  proof = { checks: [], screenshots: [] };
let createCount = 0,
  probeCount = 0,
  liveEnabled = false;
function make(entry, id, ready = false) {
  return {
    id,
    instrument_id: "H:" + id.slice(0, 10),
    logical_symbol: entry.logical_symbol,
    display_symbol: entry.source === "yahoo" ? entry.logical_symbol : entry.display_symbol,
    provider_display_symbol: entry.display_symbol,
    instrument_name: entry.label,
    precision: entry.precision,
    source_display: entry.source === "yahoo" ? "Yahoo Finance" : "Dukascopy",
    asset_class: entry.asset_class,
    aggregation_calendar: entry.source === "yahoo" ? "source_date" : "ny17",
    identity: {
      source: entry.source,
      provider_symbol: entry.provider_symbol,
      mode: entry.default_mode || "base_m1",
      basis: "bid",
    },
    maintenance: {
      configured: true,
      configuration_revision: "1".repeat(64),
      target_start: start,
      timeframes:
        entry.source === "yahoo" ? ["D1", "W1", "MN"] : ["M1", "H4", "D1"],
      frequency: "daily",
      timezone: "UTC",
      daily_minute: 15,
      overlap_minutes: 2880,
      paused: false,
      archived: false,
      active_version_id: ready ? null : vid,
      task_status: ready ? "published" : "pending",
      frame_plan:
        entry.source === "yahoo"
          ? { D1: { schedule: "daily", interval_minutes: 60, overlap_bars: 7 } }
          : {},
    },
    availability: ready ? "available" : "preparing",
    available_start: ready ? start : null,
    available_end: ready ? now : null,
    usable_timeframes: ready
      ? entry.source === "yahoo"
        ? ["D1", "W1", "MN"]
        : ["M1", "H4", "D1"]
      : [],
    periods: ready
      ? [
          {
            timeframe: entry.source === "yahoo" ? "D1" : "M1",
            available_version_id: vid,
          },
        ]
      : [],
    continuation: { enabled: false, configured: false, status: "disabled" },
  };
}
function publish(id) {
  const d = datasets.get(id);
  Object.assign(d, {
    availability: "available",
    available_start: start,
    available_end: now,
    usable_timeframes: d.maintenance.timeframes,
    periods: d.maintenance.timeframes.map((timeframe) => ({
      timeframe,
      available_version_id: vid,
    })),
  });
  d.maintenance.active_version_id = null;
  d.maintenance.task_status = "published";
  if (tasks.has(id)) tasks.get(id).status = "published";
}
function continuation(id) {
  const d = datasets.get(id),
    maps = mappings.get(id) || [],
    enabled = !!d?.continuation?.enabled;
  return {
    dataset_id: id,
    supported: d?.identity.source !== "yahoo",
    reason:
      d?.identity.source === "yahoo"
        ? "实时接续目前只支持已核实品种的 M1 基础 Bid 行情"
        : !d?.periods.length
          ? "组合需要已有可用的固定M1历史及周期产物，请先维护"
          : !maps.length
            ? "请先配置并核对实时来源"
            : null,
    enabled,
    rollover: rolloverOverride,
    ready_to_enable: !!d?.periods.length && maps.length > 0 && !missingBaseline,
    default_mapping_id:
      (id === eid ? defaultOverride : "") || maps[0]?.id || null,
    mappings: maps,
    configurations: [],
    status: enabled ? "receiving" : "disabled",
    composite: enabled
      ? {
          id: cid,
          preparation: { status: livePrepared ? "queried" : "preparing" },
        }
      : null,
  };
}
function snapshot(symbol) {
  return {
    account_scope: "sha256:fixture",
    target_dataset_id: "f".repeat(64),
    provider_symbol: symbol,
    asset_type: symbol === "XAU_USD" ? "METAL" : "CURRENCY",
    precision: symbol === "XAU_USD" ? 3 : 5,
  };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (value, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const p = url.pathname;
    if (req.method === "POST")
      writes.push({ path: p, body: structuredClone(body) });
    if (p === "/api/session")
      return logged
        ? json({ csrf: "fixture", subject: "admin" })
        : json({}, 401);
    if (p === "/api/login") {
      logged = true;
      return json({ csrf: "fixture", subject: "admin" });
    }
    if (p === "/api/advanced-charts/preferences") return json([remote]);
    if (p === "/api/advanced-charts/preferences/save") {
      remote = { ...body, revision: remote.revision + 1 };
      return json(remote);
    }
    if (p === "/api/health")
      return json({
        ntfy_configured: false,
        delivery_enabled: false,
        chart_alerts: { loop: { state: "idle" } },
      });
    if (p === "/api/notification-center/health")
      return json({ configured: false });
    if (p.startsWith("/api/notification-center/"))
      return json({
        events: [],
        changes: [],
        epoch: "fixture",
        after: null,
        more: false,
        unread: 0,
      });
    if (p === "/api/market-data/center/dataset-summaries") {
      let rows = [...datasets.values()].filter((d) =>
        url.searchParams.get("status") === "archived"
          ? d.maintenance.archived
          : !d.maintenance.archived,
      );
      const q = url.searchParams.get("query"),
        s = url.searchParams.get("source");
      if (q)
        rows = rows.filter((d) =>
          (d.display_symbol + d.provider_display_symbol + d.instrument_name).includes(q),
        );
      if (s) rows = rows.filter((d) => d.identity.source === s);
      const anchor = url.searchParams.get("anchor")?.slice(8),
        pos = rows.findIndex((d) => d.id === anchor) + 1;
      return json({
        items: rows,
        total: rows.length,
        anchor_position: pos || null,
      });
    }
    if (p === "/api/market-data/history-catalog/search") {
      if (url.searchParams.get("source") === "oanda")
        return json({
          items: [
            {
              catalog_id: "HC:LIVE_EUR",
              source: "oanda",
              provider_symbol: url.searchParams.get("query").includes("XAU")
                ? "XAU_USD"
                : "EUR_USD",
              logical_symbol: "EURUSD",
              label: "当前账户准确品种",
              precision: 5,
            },
          ],
          total: 1,
          sources: [
            {
              source: "oanda",
              connection_configured: true,
              requires_refresh: false,
            },
          ],
        });
      const q = (url.searchParams.get("query") || "").toLowerCase(),
        s = url.searchParams.get("source");
      const items = entries.filter(
        (e) =>
          (!s || e.source === s) &&
          (!q || (e.logical_symbol + e.label).toLowerCase().includes(q)),
      );
      return json({
        items,
        total: items.length,
        sources: [
          {
            source: s || "dukascopy",
            connection_configured: true,
            requires_refresh: false,
          },
        ],
      });
    }
    if (p === "/api/market-data/history-catalog/probe") {
      probeCount++;
      if (failProbe) return json({ detail: "验证暂时不可用，请重试" }, 422);
      return json({
        frames: body.timeframes.filter((f) => ["D1", "H1"].includes(f)),
      });
    }
    if (p === "/api/market-data/history-catalog/refresh")
      return json({ ok: true });
    if (p === "/api/market-data/center/datasets/check") {
      const id =
        body.provider_symbol === "XAU/USD"
          ? gid
          : body.source === "yahoo"
            ? body.mode === "native_periods"
              ? nativeId
              : yid
            : eid;
      return json({
        status: datasets.has(id) && !hideExisting ? "existing" : "ready",
        start,
        existing: datasets.get(id) || null,
      });
    }
    if (p.startsWith("/api/market-data/center/creations/")) {
      const id =
        url.searchParams.get("provider_symbol") === "XAU/USD"
          ? gid
          : url.searchParams.get("source") === "yahoo"
            ? url.searchParams.get("mode") === "native_periods"
              ? nativeId
              : yid
            : eid;
      return json({ found: datasets.has(id), dataset: datasets.get(id) });
    }
    if (p === "/api/market-data/center/datasets" && req.method === "POST") {
      if (hideExisting) {
        hideExisting = false;
        return json({ detail: { message: "此行情已有维护配置" } }, 409);
      }
      createCount++;
      const entry = entries.find(
          (e) => e.catalog_id === body.dataset.catalog_id,
        ),
        id =
          entry.source === "yahoo"
            ? body.dataset.mode === "native_periods"
              ? nativeId
              : yid
            : entry.logical_symbol === "XAUUSD"
              ? gid
              : eid;
      const dataset = make(entry, id);
      dataset.identity.mode = body.dataset.mode || "base_m1";
      assert.deepEqual(
        body.dataset.timeframes || body.maintenance.timeframes,
        ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"].filter((f) =>
          body.maintenance.timeframes.includes(f),
        ),
      );
      Object.assign(dataset.maintenance, body.maintenance);
      datasets.set(id, dataset);
      tasks.set(id, {
        id: vid,
        dataset,
        status: "pending",
        task_kind: "update",
        start,
        end: now,
        cursor: start,
        controllable: true,
      });
      return json({ dataset, task: { id: vid } }, 201);
    }
    const detail =
      /^\/api\/market-data\/center\/datasets\/([a-f0-9]{64})$/.exec(p);
    if (detail) return json(datasets.get(detail[1]));
    const managed =
      /^\/api\/market-data\/datasets\/([a-f0-9]{64})\/(maintenance(?:\/control)?|continuation|mappings|mapping-check|tasks)$/.exec(
        p,
      );
    if (managed) {
      const id = managed[1],
        kind = managed[2],
        d = datasets.get(id);
      if (kind === "maintenance" && req.method === "GET")
        return json(d.maintenance);
      if (kind === "maintenance" && req.method === "POST") {
        if (conflict) {
          conflict = false;
          d.maintenance.configuration_revision = "2".repeat(64);
          return json(
            {
              detail: {
                code: "MAINTENANCE_CHANGED",
                message: "其他窗口已修改",
              },
            },
            409,
          );
        }
        Object.assign(d.maintenance, body, {
          configuration_revision: "3".repeat(64),
        });
        return json(d.maintenance);
      }
      if (kind === "maintenance/control") {
        if (body.action === "pause" || body.action === "resume")
          d.maintenance.paused = body.action === "pause";
        else d.maintenance.archived = body.action === "archive";
        return json(d.maintenance);
      }
      if (kind === "tasks") {
        d.maintenance.active_version_id = vid;
        d.maintenance.task_status = "pending";
        tasks.set(id, {
          id: vid,
          dataset: d,
          status: "pending",
          task_kind: body.kind || "update",
          start: body.start || start,
          end: body.end || now,
          cursor: start,
          controllable: true,
        });
        return json(tasks.get(id));
      }
      if (kind === "mapping-check") {
        const gold = id === gid,
          symbol = gold ? "XAU_USD" : "EUR_USD";
        const suggestion = {
          schema_version: 2,
          underlying: gold ? "XAU" : "EUR",
          quote_currency: "USD",
          historical_product: gold ? "cfd" : "spot_fx",
          live_product: gold ? "metal_quote" : "spot_fx",
          relationship: gold
            ? "same_underlying_different_product"
            : "same_product",
          rationale: "",
          reviewed: false,
          historical_evidence: null,
          live_evidence: null,
        };
        const ready = !gold || body.match?.reviewed;
        return json({
          status: ready ? "ready" : "needs_information",
          errors: ready ? {} : { reviewed: "请确认黄金差异" },
          suggestion,
          snapshot: snapshot(symbol),
          sources: [],
          difference: gold ? "黄金两来源并非同一产品，保留 Bid 原价差异" : null,
          conclusion: "已核实来源规则",
        });
      }
      if (kind === "mappings" && req.method === "GET")
        return json({ items: mappings.get(id) || [] });
      if (kind === "mappings" && req.method === "POST") {
        const map = {
          id: mid,
          current_account: true,
          valid_for_selection: true,
          target_identity: {
            account_scope: "sha256:fixture",
            environment: "practice",
            provider_symbol: id === gid ? "XAU_USD" : "EUR_USD",
          },
          match: body.match,
          note: null,
        };
        mappings.set(id, [map]);
        return json(map, 201);
      }
      if (kind === "continuation") {
        if (req.method === "POST") {
          if (missingBaseline && body.enabled)
            return json(
              { detail: "缺少日界之前的 M1 历史基线，请先准备历史" },
              422,
            );
          if (failEnable && body.enabled)
            return json({ detail: "供应商暂不可用" }, 422);
          d.continuation = {
            enabled: body.enabled,
            configured: true,
            status: body.enabled ? "receiving" : "disabled",
          };
          liveEnabled = body.enabled;
          if (body.enabled && id === eid) defaultOverride = body.mapping_id;
        }
        return json(continuation(id));
      }
    }
    if (p === "/api/market-data/center/tasks") {
      const id = url.searchParams.get("dataset_id");
      const items = [...tasks]
        .filter(([k]) => !id || k === id)
        .map(([, v]) => v);
      return json({ items, total: items.length });
    }
    if (p.match(/^\/api\/market-data\/tasks\/.*\/control$/)) {
      const task = [...tasks.values()].find((t) => t.id === p.split("/")[4]);
      if (task) {
        task.status = {
          pause: "paused",
          resume: "running",
          retry: "running",
          cancel: "cancelled",
        }[body.action];
        task.dataset.maintenance.task_status = task.status;
        if (body.action === "cancel")
          task.dataset.maintenance.active_version_id = null;
      }
      return json(task || {});
    }
    if (p === "/api/market-data/date-boundary")
      return json({
        start: Date.parse(url.searchParams.get("date") + "T00:00:00Z"),
      });
    if (p === "/api/market-data/versions")
      return json([
        {
          id: vid,
          status: "published",
          start,
          end: now,
          published_at: now,
          payload_available: true,
        },
      ]);
    if (p === "/api/market-data/sources")
      return json([{ source: "dukascopy", native_status: "supported" }]);
    if (p === "/api/market-data/catalog/directory-status") return json([]);
    if (p === "/api/market-data/live/status")
      return json({ provider: { configured: true }, datasets: [] });
    if (p === "/api/market-data/resolve")
      return json({
        source: "dukascopy",
        frames: ["M1", "H4", "D1"],
        basis: "bid",
      });
    if (p === "/api/advanced-charts/catalog") return json({});
    if (p === "/api/charts/history-capabilities")
      return json({
        protocol: 1,
        version: "fixture",
        mode: "continuous",
        max_bars: 20000,
        workspace_bars: 100000,
        default_bars: 1000,
        task_seconds: 30,
      });
    if (p === "/api/charts/data")
      return json({
        bars: [],
        has_more: false,
        pending: [],
        revision_id: vid,
        input_revision: 1,
        as_of: now,
      });
    if (p === "/api/market-data/quotes") return json([]);
    if (p === "/api/market-data/sparklines") return json({ items: [] });
    if (p === "/api/charts/stream/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: heartbeat\ndata: {}\n\n");
      return;
    }
    if (p.startsWith("/api/charts/stream/")) return json({ ok: true });
    if (p.startsWith("/api/"))
      return json({ detail: "fixture missing " + p }, 404);
    let file = path.join(dist, decodeURIComponent(p));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, "index.html");
    if (!fs.existsSync(file) && p.startsWith("/m"))
      file = path.join(dist, "m/index.html");
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[path.extname(file)] || "application/octet-stream",
    });
    res.end(fs.readFileSync(file));
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end();
  }
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    }),
    page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/market-data/**", async (route) => {
    const req = route.request(),
      p = new URL(req.url()).pathname;
    let lose = false;
    if (req.method() === "POST") {
      if (p === "/api/market-data/center/datasets" && createLost) {
        createLost = false;
        lose = true;
      }
      if (p.endsWith("/mappings") && mappingLost) {
        mappingLost = false;
        lose = true;
      }
      if (p.endsWith("/continuation") && enableLost) {
        enableLost = false;
        lose = true;
      }
    }
    if (lose) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  const dialog = (name) =>
    name
      ? page.getByRole("dialog", { name, exact: true })
      : page.getByRole("dialog").last();
  const settle = () => page.waitForTimeout(400);
  async function shot(name) {
    await settle();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      name + " page overflow",
    );
    if (await dialog().count())
      assert(
        await dialog().evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
        name + " drawer overflow",
      );
    if (await dialog().count())
      assert.deepEqual(
        await dialog().evaluate((el) =>
          [...el.querySelectorAll("button,input,select")]
            .filter(
              (node) =>
                node.getClientRects().length &&
                getComputedStyle(node).visibility !== "hidden" &&
                !node.dataset.slot &&
                !node.dataset.variant &&
                node.getAttribute("aria-hidden") !== "true",
            )
            .map((node) => node.outerHTML.slice(0, 100)),
        ),
        [],
        name + " shared control inventory",
      );
    await page.screenshot({ path: path.join(out, name + ".png") });
    proof.screenshots.push(name);
  }
  async function close(name) {
    await dialog(name)
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await settle();
  }
  async function back() {
    await page.evaluate(() =>
      dispatchEvent(new Event("mw-mobile-back", { cancelable: true })),
    );
    await settle();
  }
  async function details(code = "EURUSD") {
    await page.locator(".data-managed-row").filter({ hasText: code }).click();
    await expect(
      dialog("自建行情").getByRole("button", { name: "维护设置", exact: true }),
    ).toBeVisible();
  }
  async function more() {
    await dialog("自建行情")
      .getByRole("button", { name: "更多操作", exact: true })
      .click();
  }
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/m/data`);
    await page.getByLabel("密码", { exact: true }).fill("fixture");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByText("还没有自建行情", { exact: true }),
    ).toBeVisible();
    assert.equal(
      await page.getByRole("tab", { name: "原生", exact: true }).count(),
      0,
    );
    await shot("01-empty");
    await page
      .getByRole("button", { name: "搜索并添加行情", exact: true })
      .click();
    await expect(
      dialog("添加行情").getByRole("button").filter({ hasText: "EURUSD" }),
    ).toBeVisible();
    await shot("02-catalog");
    await dialog("添加行情")
      .getByRole("button")
      .filter({ hasText: "EURUSD" })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "创建并准备历史",
        exact: true,
      }),
    ).toBeEnabled();
    await shot("03-create");
    const creationDay = dialog("创建自建行情").getByLabel("历史起点", {
        exact: true,
      }),
      originalDay = await creationDay.inputValue();
    await creationDay.fill("2026-10-01");
    await back();
    await expect(
      page.getByRole("alertdialog", { name: "放弃本次修改？", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(
      page.getByRole("alertdialog", { name: "放弃本次修改？", exact: true }),
    ).toHaveCount(0);
    await expect(creationDay).toHaveValue("2026-10-01");
    await creationDay.fill(originalDay);
    proof.checks.push(
      "creation Android back asks once and retains the edited date",
    );
    await dialog("创建自建行情")
      .getByRole("button", { name: "创建并准备历史", exact: true })
      .click();
    await expect(page.locator(".data-managed-row")).toHaveCount(1);
    assert.equal(createCount, 1);
    proof.checks.push(
      "lost creation response reconciles exact request; no duplicate creation",
    );
    await details();
    await dialog("自建行情")
      .getByRole("button", { name: "查看进度", exact: true })
      .click();
    await expect(
      dialog("维护任务").getByText("排队中", { exact: true }),
    ).toBeVisible();
    await shot("04-tasks");
    await dialog("维护任务")
      .getByRole("button", { name: "暂停任务", exact: true })
      .click();
    await expect(
      dialog("维护任务").getByText("任务已暂停", { exact: true }),
    ).toBeVisible();
    assert.equal(datasets.get(eid).maintenance.paused, false);
    await dialog("维护任务")
      .getByRole("button", { name: "继续任务", exact: true })
      .click();
    publish(eid);
    await close("维护任务");
    await expect(
      dialog("自建行情").getByRole("button", { name: "立即更新", exact: true }),
    ).toBeVisible();
    await shot("05-detail-ready");
    await dialog("自建行情")
      .getByRole("button", { name: "维护设置", exact: true })
      .click();
    await expect(
      dialog("维护设置").getByLabel("历史起点", { exact: true }),
    ).toBeVisible();
    await shot("06-maintenance");
    await dialog("维护设置")
      .getByLabel("维护时间", { exact: true })
      .fill("01:30");
    conflict = true;
    await dialog("维护设置")
      .getByRole("button", { name: "保存维护设置", exact: true })
      .click();
    await expect(
      dialog("维护设置").getByRole("button", {
        name: "载入最新维护设置",
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(
      await dialog("维护设置")
        .getByLabel("维护时间", { exact: true })
        .inputValue(),
      "01:30",
    );
    await dialog("维护设置")
      .getByRole("button", { name: "载入最新维护设置", exact: true })
      .click();
    await dialog("维护设置")
      .getByLabel("维护时间", { exact: true })
      .fill("02:30");
    await dialog("维护设置")
      .getByRole("button", { name: "保存维护设置", exact: true })
      .click();
    await expect(dialog("维护设置").getByText(/维护设置已保存/)).toBeVisible();
    assert.equal(datasets.get(eid).maintenance.daily_minute, 150);
    await close("维护设置");
    proof.checks.push(
      "maintenance conflict retains edits; explicit reload; schedule save does not queue task",
    );
    await more();
    await dialog("自建行情")
      .getByRole("button", { name: "暂停定时维护", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByText("已暂停", { exact: true }),
    ).toBeVisible();
    assert.equal(liveEnabled, false);
    await dialog("自建行情")
      .getByRole("button", { name: "开启实时", exact: true })
      .click();
    await expect(
      dialog("确认实时来源").getByRole("button", {
        name: "确认并开启",
        exact: true,
      }),
    ).toBeEnabled();
    await shot("07-live-confirm");
    mappingLost = true;
    await dialog("确认实时来源")
      .getByRole("button", { name: "确认并开启", exact: true })
      .click();
    await expect(
      dialog("确认实时来源").getByRole("button", {
        name: "核查配置并开启",
        exact: true,
      }),
    ).toBeEnabled();
    enableLost = true;
    await dialog("确认实时来源")
      .getByRole("button", { name: "核查配置并开启", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByText("已开启 · 运行中", { exact: true }),
    ).toBeVisible();
    assert.equal(writes.filter((w) => w.path.endsWith("/mappings")).length, 1);
    await shot("08-live-running");
    proof.checks.push(
      "mapping lost-response reconciliation and continuation lost-response readback; paused schedule does not block real-time",
    );
    await dialog("自建行情")
      .getByRole("button", { name: "关闭实时", exact: true })
      .click();
    await expect(
      page.getByRole("alertdialog", { name: "关闭实时行情？", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("alertdialog", { name: "关闭实时行情？", exact: true })
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByText("未开启", { exact: true }),
    ).toBeVisible();
    assert.equal(datasets.get(eid).maintenance.paused, true);
    await dialog("自建行情")
      .getByRole("button", { name: "开启实时", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByText("已开启 · 运行中", { exact: true }),
    ).toBeVisible();
    assert.equal(writes.filter((w) => w.path.endsWith("/mappings")).length, 1);
    await dialog("自建行情")
      .getByRole("button", { name: "加入自选", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByRole("button", {
        name: "已加入自选",
        exact: true,
      }),
    ).toBeVisible();
    assert.deepEqual(remote.content.value.lists[0].symbols, ["MWC:" + cid]);
    assert.equal(remote.content.value.active, "desktop");
    assert.equal(remote.content.value.unknown, "keep");
    await more();
    await dialog("自建行情")
      .getByRole("button", { name: "区间补数与复查", exact: true })
      .click();
    await dialog("区间维护")
      .getByLabel("起始交易日期", { exact: true })
      .fill("2026-10-01");
    await dialog("区间维护")
      .getByLabel("结束交易日期（不包含）", { exact: true })
      .fill("2026-10-03");
    await dialog("区间维护")
      .getByRole("button", { name: "提交补数", exact: true })
      .click();
    await expect(dialog("区间维护").getByText(/区间维护已提交/)).toBeVisible();
    await shot("09-range");
    await close("区间维护");
    await close("自建行情");
    await page
      .getByRole("button", { name: "搜索并添加行情", exact: true })
      .click();
    await dialog("添加行情")
      .getByRole("button")
      .filter({ hasText: "XAUUSD" })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "创建并准备历史",
        exact: true,
      }),
    ).toBeEnabled();
    await dialog("创建自建行情")
      .getByRole("button", { name: "创建并准备历史", exact: true })
      .click();
    await expect(page.locator(".data-managed-row")).toHaveCount(2);
    publish(gid);
    await details("XAUUSD");
    await dialog("自建行情")
      .getByRole("button", { name: "开启实时", exact: true })
      .click();
    await expect(
      dialog("确认实时来源").getByRole("button", {
        name: "我已确认产品差异，接受 Bid 原价接续",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog("确认实时来源").getByRole("button", {
        name: "确认并开启",
        exact: true,
      }),
    ).toBeDisabled();
    await shot("10-gold-difference");
    await dialog("确认实时来源")
      .getByRole("button", {
        name: "我已确认产品差异，接受 Bid 原价接续",
        exact: true,
      })
      .click();
    await expect(
      dialog("确认实时来源").getByRole("button", {
        name: "确认并开启",
        exact: true,
      }),
    ).toBeEnabled();
    failEnable = true;
    await dialog("确认实时来源")
      .getByRole("button", { name: "确认并开启", exact: true })
      .click();
    await expect(
      dialog("确认实时来源").getByText(/配置已保存，实时未开启/),
    ).toBeVisible();
    failEnable = false;
    await dialog("确认实时来源")
      .getByRole("button", { name: "重试开启实时", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByText("已开启 · 运行中", { exact: true }),
    ).toBeVisible();
    await close("自建行情");
    proof.checks.push(
      "gold difference cannot be skipped; saved mapping survives enable failure",
    );
    await page
      .getByRole("button", { name: "搜索并添加行情", exact: true })
      .click();
    await dialog("添加行情")
      .getByRole("button")
      .filter({ hasText: "AAPL" })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "创建并准备历史",
        exact: true,
      }),
    ).toBeEnabled();
    assert.equal(probeCount, 1);
    await shot("11-yahoo-create");
    await dialog("创建自建行情")
      .getByRole("button", { name: "创建并准备历史", exact: true })
      .click();
    await expect(page.locator(".data-managed-row")).toHaveCount(3);
    publish(yid);
    datasets.get(yid).maintenance.frame_plan.D1.overlap_bars = 7;
    await details("AAPL");
    await expect(
      dialog("自建行情").getByText(/实时接续目前只支持/),
    ).toBeVisible();
    await expect(
      dialog("自建行情").getByRole("button", { name: "开启实时", exact: true }),
    ).toBeDisabled();
    await dialog("自建行情")
      .getByRole("button", { name: "维护设置", exact: true })
      .click();
    await dialog("维护设置")
      .getByLabel("维护时间", { exact: true })
      .fill("03:00");
    await dialog("维护设置")
      .getByRole("button", { name: "保存维护设置", exact: true })
      .click();
    await expect(dialog("维护设置").getByText(/维护设置已保存/)).toBeVisible();
    assert.equal(datasets.get(yid).maintenance.frame_plan.D1.overlap_bars, 7);
    await close("维护设置");
    await close("自建行情");
    proof.checks.push(
      "Yahoo probes once, creates native archive, preserves hidden frame settings, unsupported live stays unavailable",
    );
    // Repeating the selection never overwrites an existing maintenance plan.
    const eurPlan = JSON.stringify(datasets.get(eid).maintenance),
      countBefore = createCount;
    await page
      .getByRole("button", { name: "搜索并添加行情", exact: true })
      .click();
    await dialog("添加行情")
      .getByRole("button")
      .filter({ hasText: "EURUSD" })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "查看已有自建",
        exact: true,
      }),
    ).toBeVisible();
    await dialog("创建自建行情")
      .getByRole("button", { name: "查看已有自建", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "已定位已有自建行情" }),
    ).toBeVisible();
    assert.equal(createCount, countBefore);
    assert.equal(JSON.stringify(datasets.get(eid).maintenance), eurPlan);
    // A concurrent creator can win between check and POST; re-check before proceeding.
    hideExisting = true;
    await page
      .getByRole("button", { name: "搜索并添加行情", exact: true })
      .click();
    await dialog("添加行情")
      .getByRole("button")
      .filter({ hasText: "EURUSD" })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "创建并准备历史",
        exact: true,
      }),
    ).toBeEnabled();
    await dialog("创建自建行情")
      .getByRole("button", { name: "创建并准备历史", exact: true })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "查看已有自建",
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(createCount, countBefore);
    assert.equal(JSON.stringify(datasets.get(eid).maintenance), eurPlan);
    await close("创建自建行情");
    proof.checks.push(
      "duplicate pre-check and concurrent 409 lead to existing dataset without overwriting settings",
    );
    // A failed source validation never permits creation; explicit retry recovers.
    failProbe = true;
    await page
      .getByRole("button", { name: "搜索并添加行情", exact: true })
      .click();
    await dialog("添加行情")
      .getByRole("button")
      .filter({ hasText: "AAPL" })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "重试验证",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "创建并准备历史",
        exact: true,
      }),
    ).toBeDisabled();
    failProbe = false;
    await dialog("创建自建行情")
      .getByRole("button", { name: "重试验证", exact: true })
      .click();
    await expect(
      dialog("创建自建行情").getByRole("button", {
        name: "查看已有自建",
        exact: true,
      }),
    ).toBeVisible();
    await dialog("创建自建行情")
      .getByRole("button", { name: "更多设置", exact: true })
      .click();
    const beforeNativeProbe = probeCount;
    await dialog("创建自建行情")
      .getByRole("combobox", { name: "历史模式", exact: true })
      .click();
    await page.getByRole("option", { name: "原生多周期", exact: true }).click();
    await expect.poll(() => probeCount).toBe(beforeNativeProbe + 1);
    await expect(
      dialog("创建自建行情").getByRole("button", { name: "H1", exact: true }),
    ).toBeVisible();
    await expect(
      dialog("创建自建行情").getByRole("button", { name: "H1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await shot("18-native-periods");
    await dialog("创建自建行情")
      .getByRole("button", { name: "创建并准备历史", exact: true })
      .click();
    await expect(page.locator(".data-managed-row")).toHaveCount(4);
    publish(nativeId);
    assert.deepEqual(datasets.get(nativeId).maintenance.timeframes, [
      "H1",
      "D1",
    ]);
    proof.checks.push(
      "failed probe blocks creation; retry recovers; native-mode change probes its required timeframes",
    );
    const beforeMappingWrites = writes.filter((w) =>
      w.path.endsWith("/mappings"),
    ).length;
    const second = {
      ...structuredClone(mappings.get(eid)[0]),
      id: "8".repeat(64),
      target_display_symbol: "欧元美元 · 已保存配置二",
    };
    mappings.set(eid, [...mappings.get(eid), second]);
    defaultOverride = "9".repeat(64);
    await details();
    await dialog("自建行情")
      .getByRole("button", { name: "核对实时来源", exact: true })
      .click();
    await dialog("确认实时来源")
      .getByRole("combobox", { name: "已保存的实时配置", exact: true })
      .click();
    await page.getByRole("option", { name: /已保存配置二/ }).click();
    await dialog("确认实时来源")
      .getByRole("button", { name: "确认并开启", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByText("已开启 · 运行中", { exact: true }),
    ).toBeVisible();
    assert.equal(defaultOverride, second.id);
    assert.equal(
      writes.filter((w) => w.path.endsWith("/mappings")).length,
      beforeMappingWrites,
    );
    await close("自建行情");
    proof.checks.push(
      "invalid default among multiple mappings requires explicit selection and reuses the selected mapping",
    );
    rolloverOverride = {
      status: "deferred",
      reason: "固定价格告警仍绑定旧基线",
      requires_attention: true,
      warning: "接续点即将超出实时保留窗口，请处理阻止基线轮换的规则",
      window_remaining_ms: 86400000,
    };
    await details();
    await expect(dialog("自建行情").getByText(rolloverOverride.warning, { exact: true })).toBeVisible();
    await shot("18b-rollover-window-warning");
    await close("自建行情");
    rolloverOverride = null;
    proof.checks.push("deferred baseline rotation shows actionable retention-window warning in managed details");
    // Archiving is reversible and does not turn off real-time or erase history.
    await details();
    await more();
    await dialog("自建行情")
      .getByRole("button", { name: "归档行情", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "归档此行情？", exact: true })
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect.poll(() => datasets.get(eid).maintenance.archived).toBe(true);
    assert(datasets.get(eid).continuation.enabled);
    await close("自建行情");
    await expect(page.locator(".data-managed-row")).toHaveCount(3);
    await page
      .getByRole("button", { name: "筛选与数据工具", exact: true })
      .click();
    await dialog("筛选与工具")
      .getByRole("combobox", { name: "显示范围", exact: true })
      .click();
    await page.getByRole("option", { name: "已归档", exact: true }).click();
    await close("筛选与工具");
    await expect(page.locator(".data-managed-row")).toHaveCount(1);
    await details();
    await more();
    await dialog("自建行情")
      .getByRole("button", { name: "取消归档", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "恢复此行情？", exact: true })
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect.poll(() => datasets.get(eid).maintenance.archived).toBe(false);
    await close("自建行情");
    await page
      .getByRole("button", { name: "清除筛选", exact: true })
      .first()
      .click();
    await expect(page.locator(".data-managed-row")).toHaveCount(4);
    // Missing baseline is explained by the server and never silently enables.
    datasets.get(eid).continuation.enabled = false;
    missingBaseline = true;
    await details();
    await dialog("自建行情")
      .getByRole("button", { name: "开启实时", exact: true })
      .click();
    await expect(dialog("自建行情").getByText(/缺少日界之前/)).toBeVisible();
    assert.equal(datasets.get(eid).continuation.enabled, false);
    missingBaseline = false;
    await dialog("自建行情")
      .getByRole("button", { name: "开启实时", exact: true })
      .click();
    await expect(
      dialog("自建行情").getByText("已开启 · 运行中", { exact: true }),
    ).toBeVisible();
    await close("自建行情");
    livePrepared = false;
    await details();
    await expect(
      dialog("自建行情").getByRole("button", { name: "打开图表", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog("自建行情").getByRole("button", { name: "加入自选", exact: true }),
    ).toBeDisabled();
    await close("自建行情");
    livePrepared = true;
    proof.checks.push(
      "archive/unarchive preserves live/history; missing baseline blocks live; preparing live blocks use without fallback",
    );
    // Source tools remain discoverable without occupying the home header.
    await page
      .getByRole("button", { name: "筛选与数据工具", exact: true })
      .click();
    await dialog("筛选与工具")
      .getByRole("button", { name: "任务与来源", exact: true })
      .click();
    await expect(
      dialog("任务与来源").getByText("近期维护任务", { exact: true }),
    ).toBeVisible();
    await dialog("任务与来源")
      .getByRole("button", { name: "来源能力与目录", exact: true })
      .click();
    await shot("19-tools");
    await close("任务与来源");
    // Use the actual app theme preference, so portal theme inheritance is exercised.
    async function theme(value) {
      await page.getByRole("link", { name: "更多", exact: true }).click();
      if (
        (await page.locator(".mobile-app").getAttribute("data-theme")) !== value
      )
        await page.getByRole("button", { name: /显示主题/ }).click();
      await page.getByRole("link", { name: "数据", exact: true }).click();
    }
    for (const color of ["light", "dark"])
      for (const width of [375, 412])
        for (const font of [14, 21]) {
          await theme(color);
          await page.setViewportSize({ width, height: 915 });
          await page.evaluate(
            (f) => (document.documentElement.style.fontSize = f + "px"),
            font,
          );
          await shot(`matrix-home-${color}-${width}-${font}`);
          await details();
          await shot(`matrix-detail-${color}-${width}-${font}`);
          await dialog("自建行情")
            .getByRole("button", { name: "维护设置", exact: true })
            .click();
          await shot(`matrix-settings-${color}-${width}-${font}`);
          await close("维护设置");
          await close("自建行情");
          await page
            .getByRole("button", { name: "搜索并添加行情", exact: true })
            .click();
          await shot(`matrix-catalog-${color}-${width}-${font}`);
          await dialog("添加行情")
            .getByRole("button")
            .filter({ hasText: "XAUUSD" })
            .click();
          await shot(`matrix-create-${color}-${width}-${font}`);
          await close("创建自建行情");
        }
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "14px"),
    );
    await page.setViewportSize({ width: 375, height: 500 });
    await details();
    await dialog("自建行情")
      .getByRole("button", { name: "维护设置", exact: true })
      .click();
    await dialog("维护设置")
      .getByLabel("维护时区", { exact: true })
      .fill("Asia/Shanghai");
    await dialog("维护设置")
      .getByRole("button", { name: "保存维护设置", exact: true })
      .scrollIntoViewIfNeeded();
    await shot("20-form-small-viewport");
    await back();
    await expect(
      page.getByRole("alertdialog", { name: "放弃本次修改？", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(
      page.getByRole("alertdialog", { name: "放弃本次修改？", exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog("维护设置").getByLabel("维护时区", { exact: true }),
    ).toHaveValue("Asia/Shanghai");
    await back();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await settle();
    await close("自建行情");
    await page.setViewportSize({ width: 412, height: 915 });
    proof.checks.push(
      "small viewport focused form keeps submit reachable; Android back/discard retains or drops input explicitly",
    );
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "14px"),
    );
    await context.setOffline(true);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      page.getByRole("status").filter({ hasText: "上次读取" }),
    ).toBeVisible();
    await details();
    await expect(
      dialog("自建行情")
        .getByRole("button", { name: "开启实时", exact: true })
        .or(
          dialog("自建行情").getByRole("button", {
            name: "关闭实时",
            exact: true,
          }),
        ),
    ).toBeDisabled();
    await expect(
      dialog("自建行情").getByRole("button", { name: "维护设置", exact: true }),
    ).toBeDisabled();
    await close("自建行情");
    await context.setOffline(false);
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(
      page.getByRole("status").filter({ hasText: "当前状态待核实" }),
    ).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await details();
    await settle();
    assert.equal(
      await dialog("自建行情").evaluate(
        (el) => getComputedStyle(el).transitionDuration,
      ),
      "0s",
    );
    await close("自建行情");
    proof.checks.push(
      "light/dark 375/412px 150% typography for home/detail/catalog/create/settings; tools; offline write guards and recovery; reduced motion",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await details();
    await dialog("自建行情")
      .getByRole("button", { name: "打开图表", exact: true })
      .click();
    await expect(page).toHaveURL(/\/m\/chart$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() =>
        writes.some(
          (w) =>
            w.path === "/api/market-data/resolve" && w.body.instrument === cid,
        ),
      )
      .toBe(true);
    await page.getByRole("link", { name: "数据", exact: true }).click();
    await details("XAUUSD");
    await expect(
      dialog("自建行情").getByRole("button", { name: "加入自选", exact: true }),
    ).toBeEnabled();
    await close("自建行情");
    proof.checks.push(
      "managed chart handoff selects exact MWC identity and releases detail state before returning to another dataset",
    );
    assert.deepEqual(errors, []);
    proof.passed = true;
    proof.writes = writes.map((w) => ({ path: w.path }));
    fs.writeFileSync(
      path.join(out, "proof.json"),
      JSON.stringify(proof, null, 2),
    );
    console.log(
      JSON.stringify({
        passed: true,
        checks: proof.checks,
        screenshots: proof.screenshots.length,
        out,
      }),
    );
  } catch (error) {
    await page.screenshot({ path: path.join(out, "failure.png") });
    console.error(error);
    console.error(
      JSON.stringify(writes.slice(-5).map((w) => ({ path: w.path }))),
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
})();
