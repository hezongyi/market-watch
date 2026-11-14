// Actual build + HTTP fixtures. Preference writes below affect this fixture only.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { chromium, expect } = require("@playwright/test");
const dist = path.resolve("dist"),
  out = process.env.MOBILE_DATA_OUTPUT || "/tmp/mw-data-final";
fs.mkdirSync(out, { recursive: true });
const dataset = "c".repeat(64),
  version = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  composite = "b".repeat(64);
const entries = {
  provider: {
    ticker: "MWP:FIXTURE-EURUSD",
    display_symbol: "EURUSD",
    instrument_name: "欧元美元",
    series_kind: "provider",
    source: "oanda",
    frames: ["M1", "M5", "H1", "D1"],
  },
  history: {
    ticker: "MWH:" + version,
    display_symbol: "EURUSD_HISTORY_LONG_CODE_2026",
    instrument_name: "欧元美元 · 固定历史数据",
    series_kind: "history",
    source: "dukascopy",
    dataset_id: dataset,
    frames: ["M1", "H1", "D1"],
  },
  composite: {
    ticker: "MWC:" + composite,
    display_symbol: "黄金接续",
    instrument_name: "黄金历史与实时接续",
    series_kind: "composite",
    source: "composite",
    frames: ["M1", "M5", "D1"],
  },
};
let continuationEnabled = false,
  continuationReady = true,
  unpublished = false,
  logged = false,
  pref = {
    kind: "setting",
    name: "mw.watchlists.v1",
    tool: "",
    revision: 1,
    content: {
      value: {
        active: "desktop",
        lists: [
          { id: "main", title: "主要观察", symbols: [] },
          { id: "long", title: "长期观察 · 外汇与全球市场", symbols: [] },
        ],
      },
    },
  };
const hold = {},
  release = {},
  fail = {},
  errors = [],
  unexpected = [],
  requests = [],
  streams = new Set(),
  proof = { checks: [], screenshots: [], layouts: [] };
function managedDataset() {
  return {
    id: dataset,
    logical_symbol: "EURUSD",
    display_symbol: entries.history.display_symbol,
    instrument_name: entries.history.instrument_name,
    source_display: "Dukascopy",
    identity: { source: "dukascopy", basis: "bid", provider_symbol: "EURUSD" },
    usable_timeframes: unpublished ? [] : entries.history.frames,
    periods: unpublished
      ? []
      : entries.history.frames.map((timeframe) => ({
          timeframe,
          available_version_id: version,
          status: "published",
          rows: 100,
        })),
    maintenance: { configured: true, paused: false, archived: false },
    availability: unpublished ? "preparing" : "available",
    available_start: 1720000000000,
    available_end: 1730000000000,
    continuation: {
      enabled: continuationEnabled,
      configured: true,
      status: continuationEnabled
        ? continuationReady
          ? "receiving"
          : "preparing"
        : "disabled",
    },
  };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const json = (v, status = 200) => {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(v));
  };
  const wait = async (key) => {
    if (hold[key]) await new Promise((resolve) => (release[key] = resolve));
    return fail[key]
      ? (json({ detail: key + "读取失败（夹具）" }, 400), true)
      : false;
  };
  if (url.pathname.startsWith("/api/"))
    requests.push({
      path: url.pathname,
      method: req.method,
      query: url.search,
      body,
    });
  if (url.pathname === "/api/session")
    return logged ? json({ csrf: "fixture", subject: "admin" }) : json({}, 401);
  if (url.pathname === "/api/login") {
    logged = true;
    return json({ csrf: "fixture", subject: "admin" });
  }
  if (url.pathname === "/api/notification-center/health")
    return json({ ok: true, configured: false });
  if (url.pathname === "/api/health")
    return json({
      ntfy_configured: false,
      delivery_enabled: false,
      chart_alerts: { loop: { state: "idle" } },
    });
  if (url.pathname === "/api/notification-center/events")
    return json({
      events: [],
      before: null,
      epoch: "fixture",
      after: null,
      more: false,
      unread: 0,
    });
  if (url.pathname === "/api/notification-center/changes")
    return json({
      events: [],
      changes: [],
      epoch: "fixture",
      after: null,
      more: false,
      unread: 0,
    });
  if (url.pathname === "/api/advanced-charts/preferences") return json([pref]);
  if (url.pathname === "/api/advanced-charts/preferences/save") {
    if (hold.save) await new Promise((resolve) => (release.save = resolve));
    if (fail.save) return json({ detail: "自选版本冲突，请重新读取" }, 409);
    pref = { ...body, revision: pref.revision + 1 };
    return json(pref);
  }
  if (url.pathname === "/api/market-data/center/dataset-summaries") {
    if (await wait("list")) return;
    const q = url.searchParams.get("query"),
      page = Number(url.searchParams.get("page") || 1);
    return json({
      items:
        q === "empty"
          ? []
          : [
              {
                ...managedDataset(),
                ...(page > 1 ? { display_symbol: "NEXT_MANAGED_PAGE" } : {}),
              },
            ],
      total: 26,
    });
  }
  if (url.pathname === "/api/market-data/center/datasets/" + dataset)
    return json(managedDataset());
  if (
    url.pathname ===
    "/api/market-data/datasets/" + dataset + "/continuation"
  ) {
    if (await wait("continuation")) return;
    return json({
      dataset_id: dataset,
      enabled: continuationEnabled,
      ready_to_enable: continuationReady,
      status: continuationEnabled
        ? continuationReady
          ? "receiving"
          : "preparing"
        : "disabled",
      reason: continuationReady
        ? null
        : "实时接续准备中，可在固定历史版本中查看已发布数据",
      composite: continuationReady
        ? { id: composite, preparation: { status: "queried" } }
        : null,
    });
  }
  if (url.pathname === "/api/market-data/series/page") {
    if (await wait("list")) return;
    const kind = url.searchParams.get("kind");
    assert.equal(
      kind,
      "provider",
      "native-only series listing; managed datasets use summaries",
    );
    const q = url.searchParams.get("query"),
      offset = Number(url.searchParams.get("offset"));
    return json({
      items:
        q === "empty"
          ? []
          : [
              {
                ...(entries[kind] || entries.provider),
                ...(offset ? { ticker: "MWP:NEXT", display_symbol: "NEXT_PAGE_SAMPLE" } : {}),
              },
            ],
      next_offset: offset ? null : 25,
    });
  }
  if (url.pathname === "/api/market-data/resolve") {
    if (await wait("detail")) return;
    return json({
      source: body.series_kind === "provider" ? "oanda" : "dukascopy",
      frames: ["M1", "M5", "M15", "H1", "H4", "D1", "W1", "MN"],
      basis: "bid",
      created: true,
      status: "published",
      dataset_id: body.series_kind === "history" ? dataset : undefined,
    });
  }
  if (url.pathname === "/api/market-data/versions/" + version)
    return json({
      id: version,
      dataset_id: dataset,
      start: 1720000000000,
      end: 1730000000000,
      status: "published",
    });
  if (url.pathname === "/api/market-data/composites/" + composite)
    return json({
      active_revision_id: "d".repeat(64),
      revision: {
        history_start: 1720000000000,
        history_end: 1730000000000,
        seam: 1730000000000,
      },
      mapping: { source_display: "OANDA" },
    });
  if (url.pathname === "/api/market-data/versions") {
    if (await wait("versions")) return;
    return json([
      {
        id: version,
        status: "published",
        start: 1720000000000,
        end: 1730000000000,
        payload_available: true,
      },
      {
        id: "e".repeat(64),
        status: "preparing",
        start: 1720000000000,
        end: 1730000000000,
      },
      {
        id: "f".repeat(64),
        status: "published",
        start: 1720000000000,
        end: 1730000000000,
        payload_available: false,
      },
    ]);
  }
  if (url.pathname === "/api/market-data/sources") {
    if (await wait("support")) return;
    return json([
      {
        source: "oanda",
        native_status: "supported",
        native_periods: ["M1", "M5", "M15", "H1", "H4", "D1", "W1", "MN"],
      },
      {
        source: "yahoo",
        native_status: "supported_when_enabled",
        native_periods: ["D1", "W1", "MN"],
      },
    ]);
  }
  if (url.pathname === "/api/market-data/catalog/directory-status")
    return json([
      {
        source: "yahoo",
        scope: "global",
        partition: "美国股票与加密货币目录",
        status: "complete",
        count: 6281,
        last_success: 1730000000000,
      },
    ]);
  if (url.pathname === "/api/market-data/live/status")
    return json({
      provider: {
        source: "oanda",
        configured: true,
        authentication_hold: false,
        error: null,
      },
      datasets: [
        {
          dataset_id: dataset,
          logical_symbol: "EURUSD",
          connection: "connected",
          quote_ready: true,
          candle_ready: false,
          market_session: "unknown",
        },
      ],
    });
  if (url.pathname === "/api/market-data/center/tasks")
    return json({
      items: Array.from(
        { length: Number(url.searchParams.get("page")) === 1 ? 20 : 1 },
        (_, i) => ({
          id: "task-" + i,
          display_symbol: "EURUSD · 历史数据准备任务 " + (i + 1),
          source: "dukascopy",
          status: "running",
        }),
      ),
      total: 21,
    });
  if (url.pathname === "/api/market-data/center/datasets")
    return json({
      items: [
        {
          id: dataset,
          logical_symbol: "EURUSD",
          identity: { source: "dukascopy" },
          availability: "available",
          maintenance: {
            configured: true,
            paused: false,
            last_success: 1730000000000,
          },
        },
      ],
      total: 1,
    });
  if (url.pathname === "/api/market-data/quotes")
    return json(
      (body.symbols || []).map((n) => ({
        n,
        s: "ok",
        v: { lp: 1.1, chp: 0, short_name: "EURUSD" },
      })),
    );
  if (url.pathname === "/api/market-data/sparklines")
    return json({ items: [] });
  if (url.pathname === "/api/advanced-charts/catalog") return json({});
  if (url.pathname === "/api/charts/history-capabilities")
    return json({
      protocol: 1,
      version: "fixture",
      mode: "continuous",
      max_bars: 20000,
      workspace_bars: 100000,
      default_bars: 1000,
      task_seconds: 30,
    });
  if (url.pathname === "/api/charts/data")
    return json({
      bars: [],
      has_more: false,
      pending: [],
      revision_id: version,
      input_revision: 1,
      as_of: Date.now(),
    });
  if (url.pathname === "/api/charts/stream/events") {
    streams.add(res);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: heartbeat\ndata: {}\n\n");
    req.on("close", () => streams.delete(res));
    return;
  }
  if (url.pathname.startsWith("/api/charts/stream/")) return json({ ok: true });
  if (url.pathname.startsWith("/api/")) {
    unexpected.push(url.pathname);
    return json({ detail: "Unexpected fixture request" }, 404);
  }
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
        ".svg": "image/svg+xml",
      }[path.extname(file)] || "application/octet-stream",
  });
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch(),
    context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    }),
    page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const dialog = () => page.getByRole("dialog").last(),
    catalog = () => page.locator(".symbol-search-row");
  const settle = async () => {
    await page.waitForTimeout(350);
    await page.evaluate(async () =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
  };
  const shot = async (name) => {
    await settle();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      name + " document overflow",
    );
    if (await dialog().count())
      assert(
        await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        name + " drawer overflow",
      );
    await page.screenshot({ path: path.join(out, name + ".png") });
    proof.screenshots.push(name);
  };
  const close = async () => {
    const el = await dialog().elementHandle();
    await dialog().getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => el.evaluate((e) => e.isConnected)).toBe(false);
  };
  const back = async () =>
    page.evaluate(() =>
      dispatchEvent(new Event("mw-mobile-back", { cancelable: true })),
    );
  const detail = async () => {
    await catalog()
      .first()
      .locator(".symbol-search-body")
      .click();
    await expect(dialog()).toHaveAccessibleName("行情详情");
    await expect(
      dialog().getByRole("button", { name: "数据身份与修订", exact: true }),
    ).toBeVisible();
  };
  const kind = async (label) => {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(catalog().first()).toBeVisible();
    await expect(
      page.getByRole("tab", { name: label, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  };
  const audit = async () => {
    assert.equal(
      await page.locator(".mobile-data dialog.mobile-sheet[open]").count(),
      0,
    );
    const old = await page
      .locator(
        ".mobile-data-surface button:visible,.mobile-data-surface input:visible,.mobile-data-surface select:visible",
      )
      .evaluateAll((els) =>
        els
          .filter(
            (el) =>
              !el.dataset.slot &&
              !el.dataset.variant &&
              el.getAttribute("aria-hidden") !== "true",
          )
          .map((el) => el.outerHTML.slice(0, 140)),
      );
    assert.deepEqual(old, [], "shadcn controls including nested surfaces");
  };
  try {
    await page.goto("http://127.0.0.1:" + server.address().port + "/m/watch");
    await page.getByLabel("密码", { exact: true }).fill("test-only");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "添加自选", exact: true }).click();
    await kind("原生");
    const search = page.getByRole("searchbox", {
      name: "搜索代码或中文",
      exact: true,
    });
    await search.fill("empty");
    await expect(
      page.getByText("没有符合条件的行情", { exact: true }),
    ).toBeVisible();
    hold.list = true;
    await search.fill("pending");
    await expect.poll(() => !!release.list).toBe(true);
    await shot("loading");
    hold.list = false;
    release.list();
    await expect(catalog().first()).toBeVisible();
    await search.fill("");
    await expect(catalog().first()).toBeVisible();
    const sourceFilters = dialog().getByRole("combobox", { name: "来源", exact: true });
    await sourceFilters.click(); await page.getByRole("option", {name: "Yahoo", exact: true}).click();
    await expect.poll(() => requests.filter(r => r.path.endsWith("/series/page")).at(-1)?.query.includes("source=yahoo")).toBe(true);
    await sourceFilters.click(); await page.getByRole("option", {name: "全部来源", exact: true}).click();
    await page.locator(".symbol-search-footer").scrollIntoViewIfNeeded();
    await expect(catalog().filter({hasText: "NEXT_PAGE_SAMPLE"})).toBeVisible();
    await expect(catalog().filter({hasText: "EURUSD"})).toBeVisible();
    await expect(page.getByRole("navigation", {name: "行情分页"})).toHaveCount(0);
    proof.checks.push(
      "shared watch native search: loading, empty, source, pagination",
    );
    hold.detail = true;
    await catalog().first().locator(".symbol-search-body").click();
    await expect(
      page.getByRole("status", { name: "正在读取详情…", exact: true }),
    ).toBeVisible();
    await shot("detail-loading");
    await expect.poll(() => Boolean(release.detail)).toBe(true);
    await close();
    hold.detail = false;
    release.detail();
    await settle();
    await expect(dialog()).toHaveAccessibleName("添加自选");
    await detail();
    await dialog()
      .getByRole("button", { name: "数据身份与修订", exact: true })
      .click();
    await expect(
      dialog().getByText(entries.provider.ticker, { exact: true }),
    ).toBeVisible();
    await shot("detail-identity");
    await dialog()
      .getByRole("combobox", { name: "添加到分组", exact: true })
      .click();
    await expect(
      page.getByRole("option", {
        name: "长期观察 · 外汇与全球市场",
        exact: true,
      }),
    ).toBeVisible();
    await back();
    await expect(dialog()).toHaveAccessibleName("行情详情");
    await dialog()
      .getByRole("combobox", { name: "添加到分组", exact: true })
      .click();
    await page
      .getByRole("option", { name: "长期观察 · 外汇与全球市场", exact: true })
      .click();
    hold.save = true;
    await dialog()
      .getByRole("button", { name: "加入自选", exact: true })
      .click();
    await expect.poll(() => Boolean(release.save)).toBe(true);
    await expect(
      dialog().getByRole("button", { name: "正在添加…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog().getByRole("button", { name: "关闭", exact: true }),
    ).toBeDisabled();
    await back();
    await expect(dialog()).toHaveAccessibleName("行情详情");
    hold.save = false;
    release.save();
    await expect(
      dialog().getByRole("button", { name: "已添加", exact: true }),
    ).toBeDisabled();
    assert.equal(
      requests.filter((r) => r.path.endsWith("/preferences/save")).length,
      1,
    );
    assert.deepEqual(
      pref.content.value.lists.find((x) => x.id === "long").symbols,
      [entries.provider.ticker],
    );
    assert.equal(pref.content.value.active, "desktop");
    await page.getByRole("button", { name: "关闭通知", exact: true }).click();
    await close();
    await detail();
    await dialog()
      .getByRole("combobox", { name: "添加到分组", exact: true })
      .click();
    await page.getByRole("option", { name: "主要观察", exact: true }).click();
    fail.save = true;
    await dialog()
      .getByRole("button", { name: "加入自选", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("冲突");
    await expect(
      dialog().getByRole("button", { name: "加入自选", exact: true }),
    ).toBeEnabled();
    assert.deepEqual(
      pref.content.value.lists.find((x) => x.id === "main").symbols,
      [],
    );
    fail.save = false;
    await page.getByRole("button", { name: "关闭通知", exact: true }).click();
    await close();
    fail.detail = true;
    await detail();
    await expect(
      dialog().getByText("暂时无法读取", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog().getByText("上次读取的详情", { exact: true }),
    ).toBeVisible();
    await shot("detail-error-cache");
    fail.detail = false;
    await dialog()
      .getByRole("button", { name: "重试读取", exact: true })
      .click();
    await expect(
      dialog().getByText("暂时无法读取", { exact: true }),
    ).toHaveCount(0);
    await close();
    proof.checks.push(
      "detail loading/abort; Badge/Collapsible; nested Select back; add guard and specified group; conflict retains state; cached detail/error/retry",
    );
    await kind("自建");
    await detail();
    await dialog()
      .getByRole("button", { name: "固定历史版本", exact: true })
      .click();
    await expect(dialog()).toHaveAccessibleName("固定历史版本");
    const versionButtons = dialog().getByRole("button", {
      name: "打开此固定版本",
      exact: true,
    });
    await expect(versionButtons).toHaveCount(3);
    await expect(versionButtons.nth(1)).toBeDisabled();
    await expect(versionButtons.nth(2)).toBeDisabled();
    await back();
    await expect(dialog()).toHaveAccessibleName("行情详情");
    await close();
    for (const width of [375, 412]) {
      await page.setViewportSize({ width, height: 915 });
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "21px"),
      );
      await shot(`shared-search-large-${width}`);
      await detail();
      await shot(`shared-detail-large-${width}`);
      await audit();
      await close();
    }
    proof.checks.push(
      "shared managed search and fixed-version guards; 375/412px large text",
    );
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "14px"),
    );
    await page.setViewportSize({ width: 412, height: 915 });
    await kind("原生");
    await context.setOffline(true);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(catalog().first()).toBeVisible({ timeout: 15000 });
    await expect(
      dialog().getByText(/上次读取/).first(),
    ).toBeVisible();
    await expect(
      page.locator(".mobile-search-content [role=alert]"),
    ).toHaveCount(0);
    await shot("offline-cache");
    await detail();
    await expect(
      dialog().getByRole("button", { name: "加入自选", exact: true }),
    ).toBeDisabled();
    await close();
    await search.fill("not-cached");
    await expect(
      page
        .locator(".mobile-search-content")
        .getByText("暂无本地数据", { exact: true }),
    ).toBeVisible();
    await shot("offline-no-cache");
    await context.setOffline(false);
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(catalog().first()).toBeVisible();
    fail.list = true;
    await search.fill("error");
    await expect(
      page.locator(".symbol-search-footer").getByText(/failed|失败|error|错误|不可用/i),
    ).toBeVisible();
    await shot("catalog-error");
    fail.list = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(catalog().first()).toBeVisible();
    await search.fill("");
    await expect(catalog().first()).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await detail();
    await settle();
    assert.equal(
      await dialog().evaluate((el) => getComputedStyle(el).transitionDuration),
      "0s",
    );
    await close();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await kind("自建");
    continuationEnabled = true;
    await search.fill("live");
    await expect(catalog()).toContainText("自建");
    await expect(catalog()).toHaveCount(1);
    await catalog()
      .getByRole("button", { name: /^添加 / })
      .click();
    await expect(
      catalog().getByRole("button", { name: /^已添加 / }),
    ).toBeDisabled();
    assert(
      pref.content.value.lists.some((l) =>
        l.symbols.includes(entries.composite.ticker),
      ),
    );
    assert(
      !pref.content.value.lists.some((l) =>
        l.symbols.includes(entries.history.ticker),
      ),
    );
    await page.getByRole("button", { name: "关闭通知", exact: true }).click();
    continuationReady = false;
    await search.fill("waiting");
    await detail();
    await expect(
      dialog().getByRole("button", { name: "打开图表", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog().getByRole("button", { name: "加入自选", exact: true }),
    ).toBeDisabled();
    await close();
    continuationEnabled = false;
    unpublished = true;
    await search.fill("unpublished");
    await detail();
    await expect(
      dialog().getByText("尚无可用的已发布数据，请在数据页准备历史", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog().getByRole("button", { name: "加入自选", exact: true }),
    ).toBeDisabled();
    await close();
    unpublished = false;
    continuationReady = true;
    await search.fill("fixed");
    await detail();
    await dialog()
      .getByRole("button", { name: "加入自选", exact: true })
      .click();
    await expect(
      dialog().getByRole("button", { name: "已添加", exact: true }),
    ).toBeDisabled();
    assert(
      pref.content.value.lists.some((l) =>
        l.symbols.includes(entries.history.ticker),
      ),
    );
    await page.getByRole("button", { name: "关闭通知", exact: true }).click();
    await close();
    proof.checks.push(
      "shared MWC/MWH selection; preparing/unpublished guards; no fallback identity; offline recovery and reduced motion",
    );
    assert.deepEqual(errors, []);
    assert.equal(
      requests.filter((r) => r.path.endsWith("/preferences/save")).length,
      4,
    );
    const forbidden = requests.filter(
      (r) =>
        r.method !== "GET" &&
        ![
          "/api/login",
          "/api/market-data/resolve",
          "/api/market-data/quotes",
          "/api/market-data/sparklines",
          "/api/advanced-charts/preferences/save",
          "/api/charts/data",
        ].includes(r.path) &&
        !r.path.startsWith("/api/charts/stream/"),
    );
    assert.deepEqual(forbidden, []);
    assert.deepEqual(unexpected, []);
    Object.assign(proof, {
      evidence:
        "HTTP fixtures; actual built UI; Android-device acceptance pending",
      errors,
      forbiddenWrites: forbidden,
      fixturePreferenceWrites: 3,
    });
    fs.writeFileSync(
      path.join(out, "proof.json"),
      JSON.stringify(proof, null, 2),
    );
    console.log(JSON.stringify({ checks: proof.checks, errors, out }));
  } catch (e) {
    await page.screenshot({ path: path.join(out, "failure.png") });
    console.error(
      JSON.stringify({
        body: await page.locator("body").innerText(),
        errors,
        unexpected,
        requests: requests.slice(-12),
      }),
    );
    throw e;
  } finally {
    for (const s of streams) s.end();
    Object.values(release).forEach((fn) => fn());
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
