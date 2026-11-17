const { auditHeaderIcons } = require('./mobile-header-icons.helper.cjs');
// Built mobile UI with explicit HTTP fixtures. No real rules or push are created.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { chromium, expect } = require("@playwright/test");
const out =
  process.env.MOBILE_ALERT_OUTPUT || "/tmp/mw-mobile-alerts-implementation";
fs.mkdirSync(out, { recursive: true });
const dist = path.resolve("dist"),
  instrument = "a".repeat(64),
  datasetId = "d".repeat(64),
  revision = "11111111-1111-4111-8111-111111111111";
let logged = false,
  lost = true,
  conflict = false,
  allowClose = false,
  handledFail = false,
  rows = [],
  createBodies = [],
  edits = [],
  actions = [],
  observations = [],
  acks = [],
  eventReads = [],
  errors = [];
const now = Date.now();
let monitorHealth = () => ({enabled:true, loop:{state:'idle',heartbeat_at:Date.now()}});
const dataset = {
  id: datasetId,
  logical_symbol: "EURUSD",
  display_symbol: "EURUSD",
  instrument_name: "欧元美元",
  identity: {
    source: "dukascopy",
    provider_symbol: "EUR/USD",
    mode: "base_m1",
    basis: "bid",
  },
  asset_class: "forex",
  aggregation_calendar: "ny17",
  usable_timeframes: ["M1", "H1"],
  periods: [{ timeframe: "M1", available_version_id: revision }],
  maintenance: {
    configured: true,
    timeframes: ["M1", "H1"],
    frequency: "daily",
    daily_minute: 15,
    timezone: "UTC",
    target_start: now - 86400000,
    configuration_revision: "r1",
  },
  continuation: { enabled: true },
  history_range: {
    start: now - 86400000,
    end: now,
    timeframe: "M1",
    version_id: revision,
  },
};
const note = {
  id: "s:incident",
  first_seq: 1,
  version: 1,
  source_kind: "chart_alert_execution",
  source_domain: "pro_chart",
  source_id: "test",
  incident_id: "incident",
  kind: "failure",
  severity: "warning",
  title: "执行缺口",
  message: "当前区间无法判定",
  occurred_at: now,
  recorded_at: now,
  viewed_at: null,
  handled_at: null,
  attention: true,
  backfill: false,
  workspace: "",
  instrument: "MWC:" + instrument,
  context: {},
  evidence: {},
  incident: { id: "incident", count: 1, closed_at: null },
};
const pageOf = () => ({
  events: [note],
  before: null,
  after: "cursor1",
  epoch: "epoch1",
  unread: 0,
  system_unread: 0,
  alert_unread: 1,
  server_time: Date.now(),
});
let events = [];
function event(index) {
  return {
    id: "event-" + index,
    alert_id: rows[0]?.id,
    display_identity: { code: "EURUSD", source: "dukascopy" },
    occurred_at: now - index * 60000,
    detected_at: now,
    price: "1.08512",
    threshold: "1.08500",
    direction: "up",
    evidence: {
      config: rows[0]?.config,
      rule_version: 1,
      ordinal: 1,
      left: "1.08512",
      late: false,
    },
    notice: { id: "notice-" + index, handled_at: null },
    notification_id: "notification-" + index,
    notification_status: "server_accepted",
    delivery_status: "server_accepted",
    ack_at: null,
  };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const json = (value, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/api/session")
    return logged ? json({ csrf: "test", subject: "admin" }) : json({}, 401);
  if (url.pathname === "/api/login") {
    logged = true;
    return json({ csrf: "test", subject: "admin" });
  }
  if (url.pathname === "/api/advanced-charts/preferences") return json([]);
  if (url.pathname === "/api/health") {
    const health=monitorHealth();
    if(health._delay)await new Promise(resolve=>setTimeout(resolve,health._delay));
    return json({
      ntfy_configured: false,
      delivery_enabled: false,
      chart_alerts: health,
    });
  }
  if (url.pathname === "/api/market-data/series/page")
    return json({ items: [], next_offset: null });
  if (url.pathname === "/api/market-data/center/dataset-summaries") {
    if (url.searchParams.get("alert_eligible") === "true" && !dataset.continuation.enabled)
      return json({ items: [], total: 0, page: 1, page_size: 25 });
    return json({ items: [dataset], total: 1 });
  }
  if (
    url.pathname ===
    "/api/market-data/datasets/" + datasetId + "/continuation"
  )
    return json({
      enabled: true,
      ready_to_enable: true,
      composite: { id: instrument, preparation: { status: "queried" } },
    });
  if (url.pathname === "/api/market-data/center/datasets/" + datasetId)
    return json(dataset);
  if (url.pathname === "/api/market-data/resolve")
    return json({
      id: instrument,
      source: "composite",
      created: true,
      frames: ["M1", "H1"],
    });
  if (url.pathname === "/api/market-data/composites/" + instrument)
    return json({
      active_revision_id: revision,
      dataset_id: datasetId,
      display_symbol: "EURUSD",
    });
  if (url.pathname === "/api/chart-alerts/capabilities")
    return json({
      indicators: ["SMA", "RSI"],
      indicator_metadata: {
        SMA: {
          parameter_schema: {
            period: { label: "计算周期", type: "integer", min: 2, max: 500 },
          },
          series: [{ key: "value", label: "指标值" }],
        },
        RSI: {
          parameter_schema: { period: { type: "integer", min: 2, max: 500 } },
          series: [{ key: "value" }],
        },
      },
      sources: [
        {
          source: "composite",
          series_kind: "composite",
          available: true,
          price_modes: {
            close: {
              available: allowClose,
              reason: allowClose ? null : "完成柱尚不可用",
            },
            intrabar: {
              available: body.timeframe === "M1",
              reason: body.timeframe === "M1" ? null : "周期不可用",
            },
          },
        },
      ],
    });
  if (url.pathname === "/api/chart-alerts/events") return json(events);
  if (url.pathname === "/api/chart-alerts/events/page") {
    eventReads.push(url.search);
    const index = Number(url.searchParams.get("before") || 0),
      items = events.filter(
        (e) =>
          !url.searchParams.get("alert_id") ||
          e.alert_id === url.searchParams.get("alert_id"),
      );
    return json({
      items: items.slice(index, index + 2),
      has_more: index + 2 < items.length,
      next_cursor: index + 2 < items.length ? String(index + 2) : null,
    });
  }
  if (url.pathname.startsWith("/api/chart-alerts/events/"))
    return json(events.find((e) => url.pathname.endsWith(e.id)));
  if (
    url.pathname.startsWith("/api/notifications/") &&
    url.pathname.endsWith("/ack")
  ) {
    acks.push(url.pathname);
    const e = events.find((e) => url.pathname.includes(e.notification_id));
    e.ack_at = Date.now();
    return json({ ok: true });
  }
  if (url.pathname === "/api/chart-alerts/page") {
    const all = rows.filter((row) =>
      url.searchParams.get("status") === "archived"
        ? row.status === "archived"
        : row.status !== "archived",
    );
    const offset = Number(url.searchParams.get("before") || 0);
    return json({
      items: all.slice(offset, offset + 50),
      next_cursor: offset + 50 < all.length ? String(offset + 50) : null,
    });
  }
  if (url.pathname === "/api/chart-alerts" && req.method === "GET")
    return json(
      rows.filter((r) =>
        url.searchParams.get("status") === "archived"
          ? r.status === "archived"
          : r.status !== "archived",
      ),
    );
  if (url.pathname === "/api/chart-alerts" && req.method === "POST") {
    createBodies.push(body);
    let row = rows.find((r) => r.request_id === body.request_id);
    if (!row) {
      row = {
        id: crypto.randomUUID(),
        request_id: body.request_id,
        name: body.config.name,
        config: body.config,
        version: 1,
        control_revision: 1,
        run: 1,
        status: "active",
        health: "warming",
        count: 0,
        max_triggers: body.config.max_triggers,
        condition_summary:
          "价格 上穿 " + (body.config.condition.right?.value || "1–2"),
        created_at: now,
        updated_at: Date.now(),
        display_identity: { code: "EURUSD" },
        market_identity: { dataset_id: datasetId, source: "dukascopy" },
        execution: { state: "preparing", label: "准备中", message: "等待接管" },
      };
      rows.push(row);
    }
    if (lost) {
      lost = false;
      return json({ detail: "test lost response" }, 503);
    }
    return json(row, 201);
  }
  if (/^\/api\/chart-alerts\/[^/]+\/judgments$/.test(url.pathname))
    return json([
      { id: "j", event_time: now, outcome: "unknown", created_at: now },
    ]);
  if (/^\/api\/chart-alerts\/[^/]+\/edit$/.test(url.pathname)) {
    edits.push(body);
    if (conflict) return json({ detail: "另一个窗口已修改" }, 409);
    const row = rows.find((r) => url.pathname.includes(r.id));
    row.version++;
    row.control_revision++;
    row.config = body.config;
    row.name = body.config.name;
    return json(row);
  }
  if (/^\/api\/chart-alerts\/[^/]+\/lifecycle$/.test(url.pathname)) {
    actions.push(body);
    const row = rows.find((r) => url.pathname.includes(r.id));
    row.control_revision++;
    if (body.action === "restart") {
      row.run++;
      row.count = 0;
    }
    row.status =
      body.action === "pause"
        ? "paused"
        : body.action === "archive"
          ? "archived"
          : "active";
    row.execution = {
      state: row.status === "active" ? "preparing" : row.status,
      label: row.status === "paused" ? "已暂停" : "准备中",
    };
    return json(row);
  }
  if (/^\/api\/chart-alerts\/[^/]+$/.test(url.pathname))
    return json(rows.find((r) => url.pathname.endsWith(r.id)));
  if (url.pathname === "/api/notification-center/events") return json(pageOf());
  if (url.pathname === "/api/notification-center/changes")
    return json({ ...pageOf(), changes: [], more: false });
  if (url.pathname === "/api/notification-center/health")
    return json({
      state: "idle",
      at: now,
      display_enabled: true,
      sound_enabled: false,
    });
  if (url.pathname === "/api/notification-center/observations") {
    observations.push(body);
    if (body.kind === "handled") {
      if (handledFail) return json({ detail: "处理暂时失败" }, 503);
      if (body.event_id === note.id) note.handled_at = now;
      for (const e of events)
        if (e.notice.id === body.event_id) e.notice.handled_at = now;
    }
    return json({ ok: true });
  }
  if (url.pathname.endsWith("/timeline"))
    return json({
      observations: [
        { id: "o", kind: "viewed", received_at: now, reported_at: now },
      ],
    });
  if (url.pathname.startsWith("/api/"))
    return json({ detail: "Unexpected " + url.pathname }, 404);
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory())
    file = path.join(file, "index.html");
  if (!fs.existsSync(file) && url.pathname.startsWith("/m"))
    file = path.join(dist, "m/index.html");
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    "Content-Type":
      {
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
      }[path.extname(file)] || "application/octet-stream",
  });
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    }),
    page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12000);
  const close = async (dialog) => {
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  const choose = async (dialog, label, text) => {
    await dialog.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: text, exact: true }).click();
  };
  const shot = async (name, reset = true) => {
    if (reset) await page
      .locator('[data-mobile-overlay="true"] .mobile-drawer-scroll')
      .last()
      .evaluateAll((nodes) => nodes.forEach((node) => (node.scrollTop = 0)));
    await page.waitForTimeout(350);
    await page.waitForFunction(() => {
      if (document.querySelector('[data-mobile-overlay="true"]')) return true;
      const slide = document.querySelector('.alert-main-tabs .mobile-tabs-slide:not([inert])');
      const viewport = slide?.closest('[data-slot="carousel-content"]');
      return !slide || !viewport || Math.abs(slide.getBoundingClientRect().left - viewport.getBoundingClientRect().left) < 0.5;
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await auditHeaderIcons(page);
    await page.screenshot({ path: path.join(out, name + ".png") });
  };
  const detail = () =>
    page.getByRole("dialog", { name: "规则详情", exact: true });
  const pick = async () => {
    await page
      .getByRole("button", { name: "创建告警", exact: true })
      .first()
      .click();
    const picker = page.getByRole("dialog", {
      name: "选择告警品种",
      exact: true,
    });
    await expect(picker.getByText("EURUSD", { exact: true })).toBeVisible();
    await picker.getByRole("button", { name: /EURUSD/ }).click();
    return page.getByRole("dialog", { name: "设置告警", exact: true });
  };
  const refresh = async () => {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await page.waitForTimeout(100);
  };
  try {
    await page.goto("http://127.0.0.1:" + server.address().port + "/m/alerts");
    await page.getByLabel("密码", { exact: true }).fill("test");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "创建告警", exact: true }).first(),
    ).toBeEnabled();
    if (process.env.MOBILE_ALERT_READINESS === '1') {
      await require('./mobile-alert-readiness.scenario.cjs')({page, context, out, shot, close, refresh, errors,
        setRows:value=>{rows=value;}, setHealth:value=>{monitorHealth=value;}, datasetId, instrument, revision});
      return;
    }
    if (process.env.MOBILE_ALERT_LIFECYCLE === '1') {
      allowClose = true;
      await require('./mobile-alert-lifecycle.scenario.cjs')({page, context, out, shot, close, refresh, choose, pick, errors,
        setRows:value=>{rows=value;}, setEvents:value=>{events=value;}, event, datasetId, instrument, revision});
      return;
    }
    await shot("empty-375-dark");
    if (process.env.MOBILE_TAB_SWIPE === "1") {
      await require('./mobile-tab-swipe.helper.cjs').verifySwipeTabs({ page, context, root: page.locator('.alert-main-tabs'), full: true });
      await page.getByRole('tab', { name: '事件记录', exact: true }).click();
      await page.getByRole('button', { name: '异常/恢复', exact: true }).click();
      const records = page.getByRole('dialog', { name: '事件记录', exact: true });
      await expect(records).toBeVisible();
      await page.waitForTimeout(400);
      await require('./mobile-tab-swipe.helper.cjs').verifySwipeTabs({ page, context, root: records.locator('.mobile-record-tabs'), full: true });
      await expect(records).toBeVisible();
      await shot('swipe-record-drawer');
      await close(records);
      await page.getByRole('tab', { name: '规则', exact: true }).click();
    }
    let form = await pick();
    await expect(
      form.getByRole("button", { name: "创建告警", exact: true }),
    ).toBeDisabled();
    await expect(
      form.getByText("完成柱尚不可用", { exact: true }),
    ).toBeVisible();
    await form.getByRole("button", { name: "触价", exact: true }).click();
    await expect(form.getByRole("button", { name: "触价", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(form.getByRole("button", { name: "收盘确认", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => form.getByRole("button", { name: "收盘确认", exact: true }).evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await form.getByLabel("目标价格", { exact: true }).fill("1.08500");
    await expect(
      form.getByRole("switch", { name: "手机推送", exact: true }),
    ).toBeDisabled();
    await choose(form, "判定周期", "H1");
    await expect(
      form.getByRole("button", { name: "创建告警", exact: true }),
    ).toBeDisabled();
    await choose(form, "判定周期", "M1");
    await shot("editor-375-dark");
    await form.locator("form").evaluate((f) => {
      f.requestSubmit();
      f.requestSubmit();
    });
    await expect(
      form.getByRole("button", { name: "核查同一次提交", exact: true }),
    ).toBeVisible();
    assert.equal(createBodies.length, 1);
    await expect(form.getByLabel("目标价格", { exact: true })).toBeDisabled();
    await form
      .getByRole("button", { name: "核查同一次提交", exact: true })
      .click();
    await expect(form).toHaveCount(0);
    assert.deepEqual(createBodies[0], createBodies[1]);
    assert.equal(createBodies[0].config.mode, "intrabar");
    assert.equal(createBodies[0].config.composite_revision_id, revision);
    assert.equal(createBodies[0].config.notify_ntfy, false);
    assert.equal(rows.length, 1);
    await expect(detail()).toContainText("准备中");
    await close(detail());
    await expect(page.locator(".alert-rule")).toContainText("准备中");
    rows[0].execution = { state: "monitoring", label: "监控中" };
    rows[0].health = "ready";
    await refresh();
    await expect(page.locator(".alert-rule")).toContainText("监控中");
    await page.locator(".alert-rule-open").first().click();
    await detail()
      .getByRole("button", { name: "编辑条件", exact: true })
      .click();
    let edit = page.getByRole("dialog", { name: "编辑告警", exact: true });
    await edit.getByLabel("目标价格", { exact: true }).fill("1.08600");
    conflict = true;
    await edit.getByRole("button", { name: "保存告警", exact: true }).click();
    await expect(edit.getByRole("alert")).toContainText("另一个窗口");
    await expect(edit.getByLabel("目标价格", { exact: true })).toHaveValue(
      "1.08600",
    );
    await page.evaluate(() =>
      dispatchEvent(new Event("mw-mobile-back", { cancelable: true })),
    );
    await page
      .getByRole("alertdialog", { name: "放弃本次修改？", exact: true })
      .getByRole("button", { name: "继续编辑", exact: true })
      .click();
    await expect(
      page.getByRole("alertdialog", { name: "放弃本次修改？", exact: true }),
    ).toHaveCount(0);
    await expect(edit).toBeVisible();
    await page.evaluate(() =>
      dispatchEvent(new Event("mw-mobile-back", { cancelable: true })),
    );
    await page
      .getByRole("alertdialog", { name: "放弃本次修改？", exact: true })
      .getByRole("button", { name: "放弃修改", exact: true })
      .click();
    await expect(edit).toHaveCount(0);
    conflict = false;
    await detail().getByRole("button", { name: "暂停", exact: true }).click();
    await expect(
      detail().getByRole("button", { name: "恢复", exact: true }),
    ).toBeVisible();
    assert.equal(actions[0].control_revision, 1);
    await close(detail());
    await page.getByRole("switch", { name: /启用/ }).first().click();
    await expect(page.locator(".alert-rule")).toContainText("准备中");
    // Complete rules are discoverable in ended scope and restart is explicit.
    rows[0].count = 1;
    rows[0].status = "completed";
    await refresh();
    await page.getByRole("button", { name: "搜索规则", exact: true }).click();
    let filter = page.getByRole("dialog", { name: "搜索规则", exact: true });
    await choose(filter, "规则范围", "已结束");
    await filter.getByRole("button", { name: "查看规则", exact: true }).click();
    await page.locator(".alert-rule-open").first().click();
    await detail()
      .getByRole("button", { name: "再次启用", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "再次启用？", exact: true })
      .getByRole("button", { name: "再次启用", exact: true })
      .click();
    await expect(detail()).toContainText("0/1 次");
    assert.equal(actions.at(-1).action, "restart");
    await detail()
      .getByRole("button", { name: "归档规则", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "归档这条规则？", exact: true })
      .getByRole("button", { name: "确认归档", exact: true })
      .click();
    await expect(detail()).toHaveCount(0);
    await page.getByRole("button", { name: "搜索规则", exact: true }).click();
    filter = page.getByRole("dialog", { name: "搜索规则", exact: true });
    await choose(filter, "规则范围", "已归档");
    await filter.getByRole("button", { name: "查看规则", exact: true }).click();
    await expect(page.locator(".alert-rule")).toHaveCount(1);
    await expect(page.locator(".alert-rule")).toContainText("已归档");
    // Existing rules never exclude a symbol from creation. Indicator schema uses real controls.
    allowClose = true;
    form = await pick();
    await form.getByRole("button", { name: "更多设置", exact: true }).click();
    await choose(form, "条件类型", "指标");
    await expect(form.getByLabel("计算周期", { exact: true })).toHaveValue(
      "20",
    );
    await form.getByLabel("目标值", { exact: true }).fill("1.09");
    await form.getByRole("button", { name: "创建告警", exact: true }).click();
    await expect(form).toHaveCount(0);
    assert.equal(
      createBodies.at(-1).config.condition.left.indicator.name,
      "SMA",
    );
    await close(detail());
    // Expiry can be edited; saving preserves expired state until explicit resume.
    rows[1].status = "expired";
    rows[1].config.expires_at = Date.now() - 60000;
    await refresh();
    await page.getByRole("button", { name: "搜索规则", exact: true }).click();
    filter = page.getByRole("dialog", { name: "搜索规则", exact: true });
    await choose(filter, "规则范围", "已结束");
    await filter.getByRole("button", { name: "查看规则", exact: true }).click();
    await page.locator(".alert-rule-open").first().click();
    await detail()
      .getByRole("button", { name: "编辑条件", exact: true })
      .click();
    edit = page.getByRole("dialog", { name: "编辑告警", exact: true });
    await edit.getByRole("button", { name: "更多设置", exact: true }).click();
    await edit.getByRole("button", { name: "不限到期", exact: true }).click();
    await edit.getByRole("button", { name: "保存告警", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(
      detail().getByRole("button", { name: "恢复", exact: true }),
    ).toBeEnabled();
    assert.equal(rows[1].status, "expired");
    await detail().getByRole("button", { name: "恢复", exact: true }).click();
    await expect(detail()).toContainText("准备中");
    await close(detail());
    events = [event(0), event(1), event(2), event(3), event(4)];
    await page.getByRole("tab", { name: "事件记录", exact: true }).click();
    await expect(page.locator(".alert-event-row").first()).toBeVisible();
    await expect
      .poll(() => eventReads.some((v) => v.includes("before=2")))
      .toBe(true);
    await shot("records-375-dark");
    await page.locator(".alert-event-row").first().click();
    let ev = page.getByRole("dialog", { name: "触发详情", exact: true });
    handledFail = true;
    await ev.getByRole("button", { name: "处理本次提醒", exact: true }).click();
    await expect(ev.getByRole("alert")).toContainText("处理状态需核查");
    assert.equal(acks.length, 1);
    assert(events[0].ack_at);
    assert.equal(events[0].notice.handled_at, null);
    handledFail = false;
    await ev.getByRole("button", { name: "处理本次提醒", exact: true }).click();
    await expect(ev).toContainText("已处理");
    assert.equal(acks.length, 1, "partial retry does not ack twice");
    await shot("event-375-dark");
    await close(ev);
    await page.getByRole("button", { name: "异常/恢复", exact: true }).click();
    let records = page.getByRole("dialog", { name: "事件记录", exact: true });
    await expect(
      records.getByRole("tab", { name: "异常 / 恢复", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await records.getByRole("button", { name: /执行缺口/ }).click();
    await page
      .getByRole("dialog", { name: "执行缺口", exact: true })
      .getByRole("button", { name: "标记已处理", exact: true })
      .click();
    await expect.poll(() => note.handled_at !== null).toBe(true);
    await close(records);
    await page.getByRole("tab", { name: "规则", exact: true }).click();
    await page.getByRole("button", { name: "搜索规则", exact: true }).click();
    filter = page.getByRole("dialog", { name: "搜索规则", exact: true });
    await choose(filter, "规则范围", "当前规则");
    await filter.getByRole("button", { name: "查看规则", exact: true }).click();
    // A closed realtime source is removed from the picker instead of appearing
    // as a selectable row that can only fail after the click.
    dataset.continuation.enabled = false;
    await page.getByRole("button", { name: "创建告警", exact: true }).first().click();
    const unavailablePicker = page.getByRole("dialog", { name: "选择告警品种", exact: true });
    await expect(unavailablePicker).toContainText("没有可创建告警的品种");
    await expect(unavailablePicker.getByRole("button", { name: /EURUSD/ })).toHaveCount(0);
    await shot("picker-excludes-disabled-realtime"); await close(unavailablePicker);
    dataset.continuation.enabled = true;
    // Range validation stays inline, preserves values and does not issue a write.
    form = await pick();
    await choose(form, "触发条件", "进入价格区间");
    await form.getByLabel("下沿价格", { exact: true }).fill("2");
    await form.getByLabel("上沿价格", { exact: true }).fill("1");
    const beforeInvalid = createBodies.length;
    await form.getByRole("button", { name: "创建告警", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("下沿价格须小于上沿价格");
    assert.equal(createBodies.length, beforeInvalid);
    await expect(form.getByLabel("下沿价格", { exact: true })).toHaveValue("2");
    await form.getByLabel("上沿价格", { exact: true }).fill("3");
    await form.getByRole("button", { name: "创建告警", exact: true }).click();
    await expect(form).toHaveCount(0); assert.equal(createBodies.at(-1).config.condition.lower, "2");
    assert.equal(createBodies.at(-1).config.condition.right, undefined); await close(detail());
    rows.pop(); await refresh();
    // Populate visual states and compare real build geometry at phone sizes/themes.
    for (const [index, code, state] of [
      [2, "XAUUSD", "monitoring"],
      [3, "NVDA", "closed"],
      [4, "BTCUSDT", "blocked"],
    ])
      rows.push({
        ...structuredClone(rows[1]),
        id: "visual-" + index,
        name: code + " 价格提醒",
        status: "active",
        count: 0,
        display_identity: { code },
        condition_summary:
          code === "XAUUSD"
            ? "价格 高于 4,250.00"
            : code === "NVDA"
              ? "价格 上穿 200.00"
              : "价格 下穿 90,000.00",
        execution: {
          state,
          label: state,
          message: state === "blocked" ? "实时已关闭" : null,
        },
        health: "ready",
      });
    await refresh();
    for (const width of [375, 412]) {
      await page.setViewportSize({ width, height: 880 });
      for (const theme of ["dark", "light"]) {
        if (
          (await page.locator(".mobile-app").getAttribute("data-theme")) !==
          theme
        ) {
          await page.getByRole("link", { name: "更多", exact: true }).click();
          await page.getByRole("button", { name: /显示主题/ }).click();
          await page.getByRole("link", { name: /^告警/ }).click();
        }
        await shot(`rules-${width}-${theme}`);
        await page.locator(".alert-rule-open").first().click();
        await shot(`detail-${width}-${theme}`);
        await close(detail());
        form = await pick();
        await shot(`editor-${width}-${theme}`);
        await close(form);
      }
    }
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "150%"),
    );
    await shot("rules-412-large");
    assert(await page.locator(".alert-rule .symbol-info > strong").evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height < 40)), "common codes stay on one line at large text");
    form = await pick();
    await shot("editor-412-large");
    await page.setViewportSize({ width: 375, height: 480 });
    await form.getByLabel("目标价格", { exact: true }).focus();
    await shot("editor-short-viewport");
    await close(form);
    if (process.env.MOBILE_ALERT_POLISH_MATRIX === "1") {
      // Full surfaces at the app's 14px / 21px font sizes; no real writes.
      const checkRuleTargets = async () => {
        const issues = await page.locator(".alert-rule").evaluateAll(nodes => nodes.flatMap(node => {
          const button = node.querySelector(".alert-rule-open").getBoundingClientRect();
          const toggle = node.querySelector('[role="switch"]');
          const rect = toggle.getBoundingClientRect();
          const hit = getComputedStyle(toggle, "::after");
          return rect.y + parseFloat(hit.top) < button.bottom || rect.x + parseFloat(hit.left) < 0 || rect.right - parseFloat(hit.right) > innerWidth ? [{text:node.textContent,button:button.toJSON(),toggle:rect.toJSON(),hit:{top:hit.top,left:hit.left,right:hit.right}}] : [];
        }));
        assert.deepEqual(issues, [], "rule details and switch have separate touch targets");
      };
      for (const width of [375, 412]) for (const theme of ["light", "dark"]) for (const font of [14, 21]) {
        await page.setViewportSize({ width, height: 880 });
        await page.evaluate(value => document.documentElement.style.fontSize = value + "px", font);
        if ((await page.locator(".mobile-app").getAttribute("data-theme")) !== theme) {
          await page.getByRole("link", { name: "更多", exact: true }).click();
          await page.getByRole("button", { name: /显示主题/ }).click();
          await page.getByRole("link", { name: /^告警/ }).click();
        }
        const key = `${width}-${theme}-${font}`;
        await expect(page.locator(".alert-rule").first()).toBeVisible();
        await shot("matrix-rules-" + key); await checkRuleTargets();
        await page.locator(".alert-rule-open").first().click();
        await shot("matrix-detail-" + key);
        await detail().getByRole("button", { name: "编辑条件", exact: true }).scrollIntoViewIfNeeded();
        await shot("matrix-detail-actions-" + key, false); await close(detail());
        await page.getByRole("button", { name: "搜索规则", exact: true }).click();
        await shot("matrix-filter-" + key); await close(page.getByRole("dialog", { name: "搜索规则", exact: true }));
        await page.getByRole("button", { name: "创建告警", exact: true }).first().click();
        let picker = page.getByRole("dialog", { name: "选择告警品种", exact: true });
        await expect(picker.getByText("EURUSD", { exact: true })).toBeVisible();
        await shot("matrix-picker-" + key);
        await picker.getByRole("button", { name: /EURUSD/ }).click();
        form = page.getByRole("dialog", { name: "设置告警", exact: true });
        await shot("matrix-editor-" + key);
        await form.getByRole("button", { name: "更多设置", exact: true }).click();
        await form.getByRole("button", { name: "创建告警", exact: true }).scrollIntoViewIfNeeded();
        await shot("matrix-editor-advanced-" + key, false); await close(form);
        await page.getByRole("tab", { name: "事件记录", exact: true }).click();
        await expect(page.locator(".alert-event-row").first()).toBeVisible();
        await shot("matrix-records-" + key);
        await page.locator(".alert-event-row").nth(1).click();
        ev = page.getByRole("dialog", { name: "触发详情", exact: true });
        await shot("matrix-event-" + key);
        await ev.getByRole("button", { name: "处理本次提醒", exact: true }).scrollIntoViewIfNeeded();
        await shot("matrix-event-actions-" + key, false); await close(ev);
        await page.getByRole("tab", { name: "规则", exact: true }).click();
      }
      await page.setViewportSize({ width: 375, height: 812 });
      await page.evaluate(() => document.documentElement.style.fontSize = "14px");
      await page.getByRole("button", { name: "搜索规则", exact: true }).click();
      filter = page.getByRole("dialog", { name: "搜索规则", exact: true });
      await choose(filter, "规则范围", "需处理");
      await filter.getByRole("searchbox", { name: "搜索规则", exact: true }).fill("BTC");
      await filter.getByRole("button", { name: "查看规则", exact: true }).click();
      await expect(page.locator(".alert-rule")).toHaveCount(1);
      await shot("filtered-rules");
      await page.getByRole("button", { name: "清除规则筛选", exact: true }).click();
      await expect(page.locator(".alert-rule")).toHaveCount(4);
      const stress = rows.find(row => row.id === "visual-4");
      stress.display_identity.code = "BTCUSDT_PERPETUAL";
      stress.market_identity = { ...stress.market_identity, description: "比特币永续合约", source: "akshare", source_family: "sina" };
      stress.condition_summary = "SMA(200) 进入 90,000.00000–99,999.99999";
      stress.execution.message = "实时来源暂不可用，请到数据详情核对供应商连接与维护状态";
      await refresh();
      await page.evaluate(() => document.documentElement.style.fontSize = "21px");
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await shot("long-condition-375-large", false);
      await page.locator(".alert-rule-open").last().click();
      await shot("long-detail-375-large"); await close(detail());
      await page.evaluate(() => document.documentElement.style.fontSize = "14px");
      await page.route("**/api/chart-alerts/page?**", route => route.fulfill({ status: 503, json: { detail: "暂时无法读取，请重试" } }));
      await refresh(); await expect(page.locator(".alert-read-error")).toBeVisible();
      await shot("read-error-keeps-rules");
      await page.unroute("**/api/chart-alerts/page?**");
      await page.locator(".alert-read-error").getByRole("button", { name: "重试", exact: true }).click();
      await expect(page.locator(".alert-read-error")).toHaveCount(0);
    }
    const pullChecks = process.env.MOBILE_ALERT_PULL_REFRESH === "1"
      ? await require("./mobile-alert-pull-refresh.scenario.cjs")({ page, context, expect, shot, choose, close })
      : [];
    const oldControls = await page.locator(".mobile-alerts button,.mobile-alerts input,.mobile-alerts select").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && node.getAttribute("aria-hidden") !== "true" && !node.dataset.slot).map(node => node.outerHTML.slice(0, 100)));
    assert.deepEqual(oldControls, [], "visible alert controls use shadcn primitives");
    assert.deepEqual(errors, []);
    await expect(page.locator("dialog.mobile-sheet")).toHaveCount(0);
    await expect(page.locator(".mobile-toast")).toHaveCount(0);
    const proof = {
      checks: [
        ...pullChecks,
        "independent symbol picker",
        "disabled realtime sources are excluded from the picker",
        "invalid range retains fields without a write",
        "per-mode/timeframe capabilities",
        "request ID and config retained after uncertain create",
        "duplicate submit fenced",
        "409 retains draft",
        "top overlay back/dirty confirmation",
        "enable intent and execution separate",
        "versioned pause/resume",
        "explicit restart resets count",
        "archived query",
        "schema-driven indicator creation",
        "expired edit then explicit resume",
        "stable historical pagination",
        "ack+handled partial success and readback",
        "shared exception history",
        "375/412 light/dark, 150% font and short viewport",
        "shadcn Drawer/Select/Field/Switch controls",
        "silent operation logs",
        ...(process.env.MOBILE_ALERT_POLISH_MATRIX === "1" ? [
          "8 combinations: 375/412 light/dark 14px/21px across ten surfaces",
          "separate rule-detail and switch touch targets",
          "combined filter and one-tap reset",
          "long code/condition/error and read-failure retention",
        ] : []),
      ],
      screenshots: fs
        .readdirSync(out)
        .filter((v) => v.endsWith(".png") && !v.startsWith("failure")),
      errors,
    };
    fs.writeFileSync(
      path.join(out, "checks.json"),
      JSON.stringify(proof, null, 2),
    );
    console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    await auditHeaderIcons(page);
    await page.screenshot({ path: path.join(out, "failure.png") });
    fs.writeFileSync(
      path.join(out, "failure.txt"),
      await page.locator("body").innerText(),
    );
    throw error;
  } finally {
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
