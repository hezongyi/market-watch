// A06 layout regression; explicit API fixtures, not device evidence.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { chromium, expect } = require("@playwright/test");
const dist = path.resolve("dist"),
  output = process.env.MOBILE_VISUAL_OUTPUT || "/tmp/mw-mobile-visual";
fs.mkdirSync(output, { recursive: true });
const symbols = ["MWP:BTCUSDT", "MWP:EURUSD"],
  codes = ["D1_BTCUSDT", "EURUSD"];
const rows = ["monitoring", "blocked", "paused"].map((state, i) => ({
  id: "rule-" + i,
  name: ["黄金突破提醒", "欧元下破提醒", "指数观察"][i],
  status: state === "paused" ? "paused" : "active",
  health: state === "blocked" ? "blocked" : "ready",
  count: 0,
  max_triggers: 1,
  version: 1,
  control_revision: 1,
  condition_summary: "向上穿越 2,700.00",
  display_identity: {
    code: ["XAUUSD", "EURUSD", "QQQ"][i],
    source: "oanda",
    series_kind: "composite",
  },
  execution: {
    state,
    label: ["监控中", "需要处理", "已暂停"][i],
    last_evaluated_at: Date.now(),
  },
  config: {
    instrument: "a".repeat(64),
    series_kind: "composite",
    source: "composite",
    timeframe: "H1",
    mode: "close",
    notify_ntfy: false,
    condition: {
      relation: "cross_up",
      left: { kind: "price" },
      right: { kind: "constant", value: "2700" },
    },
    expires_at: null,
  },
}));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const json = (value) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/api/session")
    return json({ subject: "admin", csrf: "test" });
  if (url.pathname === "/api/health")
    return json({
      ntfy_configured: false,
      delivery_enabled: false,
      chart_alerts: { loop: { state: "idle" } },
    });
  if (url.pathname === "/api/advanced-charts/preferences")
    return json([
      {
        kind: "setting",
        name: "mw.watchlists.v1",
        revision: 1,
        content: {
          value: {
            active: "all",
            lists: [{ id: "all", title: "关注", symbols }],
          },
        },
      },
    ]);
  if (url.pathname === "/api/market-data/quotes")
    return json(
      body.symbols.map((ticker) => {
        const i = symbols.indexOf(ticker);
        return {
          n: ticker,
          s: "ok",
          v: {
            short_name: codes[i],
            description_base:
              codes[i] +
              " · " +
              ["D1 synthetic D1_BTCUSDT", "欧元 / 美元"][i] +
              " · 原生 · " +
              ["Binance Spot", "OANDA"][i] +
              " · 成交价",
            description:
              codes[i] +
              " · 很长的行情描述 · 原生 · " +
              ["Binance Spot", "OANDA"][i] +
              " · 时段未核实 · 最后行情时间 2026-11-11 11:59:00 UTC",
            exchange: ["BINANCE", "OANDA"][i],
            lp: [76428.3, 1.08426][i],
            chp: [1.63, -0.22][i],
            fetch_status: "ok",
            quote_time: Date.now(),
          },
        };
      }),
    );
  if (url.pathname === "/api/market-data/sparklines") {
    const left = Math.floor(Date.now() / 86400000) * 86400000;
    return json({
      as_of: Date.now(),
      items: body.items.map((item) => ({
        ticker: item.ticker,
        window_start: left,
        window_end: left + 86400000,
        timeframe: "M1",
        points: [
          { time: left, price: "100" },
          { time: left + 3600000, price: "101" },
          { time: left + 7200000, price: "100.5" },
        ],
        status: "partial",
      })),
    });
  }
  if (url.pathname === "/api/market-data/resolve")
    return json({ id: body.instrument, source: "oanda", frames: ["M1", "H1"] });
  if (url.pathname === "/api/market-data/series/page")
    return json({
      items: symbols.map((ticker, i) => ({
        ticker,
        symbol: codes[i],
        display_symbol: codes[i],
        description: [
          "比特币 · 原生 · Binance Spot",
          "欧元 / 美元 · 原生 · OANDA",
        ][i],
        source: ["binance", "oanda"][i],
        frames: ["M1", "H1"],
      })),
      next_offset: null,
    });
  if (url.pathname === "/api/chart-alerts") return json(rows);
  if (url.pathname === "/api/chart-alerts/events") return json([]);
  if (url.pathname === "/api/charts/stream/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: heartbeat\ndata: {}\n\n");
    return;
  }
  if (url.pathname.startsWith("/api/charts/stream/")) return json({ ok: true });
  if (url.pathname.startsWith("/api/notification-center/"))
    return json({
      events: [],
      changes: [],
      more: false,
      epoch: "test",
      after: null,
      unread: 0,
      alert_unread: 0,
      system_unread: 0,
    });
  if (url.pathname.startsWith("/api/")) return json({ items: [] });
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
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    }),
    page = await context.newPage(),
    failures = [],
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const check = (ok, message) => {
    if (!ok) failures.push(message);
  };
  try {
    await page.goto("http://127.0.0.1:" + server.address().port + "/m/");
    await expect(page.locator(".mobile-watch-row")).toHaveCount(2);
    await expect(page.locator(".mobile-watch-price").first()).toContainText(
      "76,428.3",
    );
    const metrics = await page
      .locator(".mobile-watch-row")
      .first()
      .evaluate((row) => {
        const price = row.querySelector(".mobile-watch-price strong"),
          range = document.createRange();
        range.selectNodeContents(price);
        return {
          priceFits: price.scrollWidth <= price.clientWidth + 1 && [...range.getClientRects()].every(rect => rect.left >= price.getBoundingClientRect().left - 1 && rect.right <= price.getBoundingClientRect().right + 1),
          height: row.getBoundingClientRect().height,
        };
      });
    check(metrics.priceFits, "watch price with superscript fits its fixed column");
    check(
      metrics.height <= 130,
      "A06 watch identity must not become a paragraph",
    );
    await page.getByRole("link", { name: "更多", exact: true }).click();
    await expect(page.locator(".mobile-more .mobile-profile")).toBeVisible();
    check(
      (await page.locator(".mobile-profile:visible").count()) === 1,
      "A06 More profile header",
    );
    check(
      (await page.locator(".mobile-setting-group").count()) === 3,
      "A06 More has three grouped settings sections",
    );
    check(
      (await page.getByRole("button", { name: /后台通知/ }).count()) === 1,
      "notifications use a settings row",
    );
    await page.getByRole("link", { name: "告警", exact: true }).click();
    await expect(page.locator(".mobile-rule-card")).toHaveCount(3);
    check(
      (await page.locator(".mobile-health-stats > div").count()) === 3,
      "A06 alert overview has monitoring / attention / paused counts",
    );
    await page.getByRole("link", { name: "数据", exact: true }).click();
    await expect(page.locator(".mobile-series")).toHaveCount(2);
    check(
      (await page.locator(".mobile-source-bar").count()) === 1,
      "A06 compact source filter and task row",
    );
    check(
      (await page.getByRole("tab", {name: "平台", exact: true}).getAttribute("aria-selected")) === "true",
      "data categories use accessible shadcn tabs",
    );
    check(
      await page.getByRole("tablist", {name: "行情类型"}).evaluate(el => el.scrollWidth <= el.clientWidth),
      "data categories fit the available width",
    );
    for (const [width, height, font] of [
      [360, 791, 100],
      [375, 812, 100],
      [412, 915, 100],
      [412, 915, 150],
      [915, 412, 100],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        (font) =>
          (document.documentElement.style.fontSize = font * 0.875 + "%"),
        font,
      );
      for (const name of ["自选", "告警", "数据", "更多"]) {
        const dataReady =
          name === "数据"
            ? page.waitForResponse(
                (response) =>
                  response.url().includes("/api/market-data/series/page") &&
                  response.status() === 200,
              )
            : undefined;
        await page.getByRole("link", { name, exact: true }).click();
        await dataReady;
        if (name === "数据")
          await expect(page.locator(".mobile-series")).toHaveCount(2);
        if (name === "自选")
          await expect.poll(() => page.locator(".mobile-spark").evaluateAll(els =>
            els.length === 2 && els.every(el => el.querySelector("path[stroke]")),
          )).toBe(true);
        check(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${name} overflow at ${width}/${font}%`,
        );
        const nav = await page.locator(".mobile-nav").boundingBox();
        check(nav.y + nav.height <= height + 1, "navigation inside viewport");
        await page.screenshot({
          path: path.join(output, `${name}-${width}-${font}.png`),
        });
      }
    }
    await page.setViewportSize({ width: 412, height: 915 });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "87.5%"),
    );
    if (await page.locator(".mobile-setting-row").count()) {
      await page.getByRole("button", { name: /后台通知/ }).click();
      await expect(
        page.getByRole("dialog", { name: "后台通知", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: /显示主题/ }).click();
      for (const name of ["自选", "告警", "数据", "更多"]) {
        const dataReady =
          name === "数据"
            ? page.waitForResponse(
                (response) =>
                  response.url().includes("/api/market-data/series/page") &&
                  response.status() === 200,
              )
            : undefined;
        await page.getByRole("link", { name, exact: true }).click();
        await dataReady;
        if (name === "数据")
          await expect(page.locator(".mobile-series")).toHaveCount(2);
        check(
          (await page.locator(".mobile-app").getAttribute("data-theme")) ===
            "light",
          "light theme",
        );
        await page.screenshot({ path: path.join(output, `${name}-light.png`) });
      }
    }
    check(errors.length === 0, errors.join("\n"));
    console.log(
      JSON.stringify(
        {
          evidence: "A06 layout with API fixtures; not phone evidence",
          metrics,
          failures,
          errors,
          output,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(failures, []);
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
