// Real bridge/native-library save -> page refresh. Only market/storage RPCs are fixtures.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "../..");
const host =
  process.env.LAYOUT_REFRESH_HOST_ROOT || path.join(root, "advanced-host");
const library =
  process.env.CHARTING_LIBRARY_ROOT || path.join(host, "charting_library");
let row,
  preferences = [],
  nextPreference = 0;
const messages = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/parent") {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><body style="margin:0"><iframe style="width:100vw;height:100vh;border:0" src="/?parent=${encodeURIComponent(origin)}"></iframe><script>
      addEventListener('message', async e => {
        const m=e.data;if(m?.channel!=='mw-chart-v1')return;
        const value=await fixtureMessage(m);
        if(value)e.source.postMessage({channel:'mw-chart-v1',...value},location.origin);
      });
    </script>`);
    return;
  }
  const file = pathname.startsWith("/charting_library/")
    ? path.join(library, pathname.slice("/charting_library/".length))
    : path.join(host, pathname === "/" ? "index.html" : pathname);
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  res.setHeader(
    "Content-Type",
    types[path.extname(file)] || "application/octet-stream",
  );
  fs.createReadStream(file)
    .on("error", () => {
      res.statusCode = 404;
      res.end();
    })
    .pipe(res);
});
let origin;
async function rpc(m) {
  messages.push(m);
  if (m.type === "loaded")
    return {
      type: "init",
      document: row.document,
      workspace: row,
      catalog: {},
      preferences,
      history_capabilities: {protocol: 1, mode: "continuous", max_bars: 200000,
        workspace_bars: 4000000, response_bytes: 134217728},
    };
  if (m.id == null) return;
  const q = m.query,
    args = q?.args || {};
  let result;
  if (m.type === "workspace") {
    if (q.op === "list")
      result = [
        {
          ...row,
          symbol: row.document.symbol,
          resolution: row.document.interval,
        },
      ];
    else if (q.op === "load")
      result = { ...row, content: JSON.stringify(row.document.state) };
    else if (q.op === "save") {
      assert.equal(args.revision, row.revision);
      row = {
        ...row,
        name: args.name,
        revision: row.revision + 1,
        document: {
          ...row.document,
          state: JSON.parse(args.content),
          symbol: args.symbol,
          series_kind: args.symbol.startsWith("MWP:") ? "provider" : "managed",
          interval: args.resolution,
        },
      };
      result = { ...row, symbol: args.symbol, resolution: args.resolution };
    }
  } else if (m.type === "preferences") {
    if (q.op === "save") {
      result = {
        ...args,
        id: String(++nextPreference),
        revision: args.revision + 1,
      };
      preferences = preferences
        .filter(
          (p) =>
            p.kind !== args.kind ||
            p.name !== args.name ||
            p.tool !== args.tool,
        )
        .concat(result);
    } else result = { ok: true };
  } else if (q?.op === "resolve")
    result = {
      source: "binance",
      calendar: "utc0",
      precision: 5,
      basis: "fixture",
      volume_kind: "unavailable",
    };
  else if (q?.op === "quotes") result = [];
  else if (q?.op === "search") result = [];
  else if (q?.op === "viewport") result = { closed: false };
  else if (m.type === "watchlist") result = [];
  else result = {};
  return { type: "result", id: m.id, result };
}
async function settle(page) {
  const frame = page.frames().find((f) => f.url().includes("/?parent="));
  assert.ok(frame);
  await frame.waitForFunction(
    () =>
      typeof ready !== "undefined" &&
      ready &&
      !loading &&
      !nativeSaving &&
      !rangeGuard?.busy() &&
      !edgeGuard?.busy() &&
      Array.from({ length: widget.chartsCount() }, (_, i) =>
        widget.chart(i).dataReady(),
      ).every(Boolean),
    null,
    { timeout: 15000 },
  );
  return frame;
}
async function current(frame) {
  return frame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) => ({
      symbol: widget.chart(i).symbol(),
      resolution: widget.chart(i).resolution(),
    })),
  );
}
const cases = [
  { name: "single-provider", symbols: ["MWP:BTCUSDT"] },
  { name: "single-managed", symbols: ["OANDA:EUR_CHF"] },
  { name: "two-provider", symbols: ["MWP:XAUUSD", "MWP:EURUSD"] },
  { name: "two-same-instrument-mixed", symbols: ["MWP:EURUSD", "EURUSD"] },
  {
    name: "four-provider",
    symbols: ["MWP:XAUUSD", "MWP:BTCUSDT", "OANDA:EUR_CHF", "MWP:EURUSD"],
  },
  {
    name: "four-managed-first",
    symbols: ["OANDA:EUR_CHF", "MWP:BTCUSDT", "EURUSD", "MWP:EURUSD"],
  },
  {
    name: "eight-mixed",
    symbols: [
      "MWP:OANDA:EUR_CHF",
      "MWP:EURUSD",
      "EURUSD",
      "MWP:XAUUSD",
      "XAUUSD",
      "MWP:BTCUSDT",
      "BTCUSDT",
      "MWP:EURUSD",
    ],
  },
];
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  try {
    const filter = process.argv
      .find((arg) => arg.startsWith("--case="))
      ?.slice(7);
    const selected = cases.filter((item) => !filter || item.name === filter);
    assert.ok(selected.length, "unknown test case");
    for (const item of selected) {
      const page = await browser.newPage({
        viewport: { width: 1600, height: 950 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.exposeFunction("fixtureMessage", rpc);
      await page.addInitScript(() => {
        addEventListener("DOMContentLoaded", () => {
          if (!globalThis.TradingView?.widget) return;
          const Original = TradingView.widget;
          TradingView.widget = new Proxy(Original, {
            construct(target, [options]) {
              const feed = options.datafeed;
              feed.getServerTime = (cb) => cb(Date.UTC(2026, 8, 29) / 1000);
              feed.getBars = (s, r, p, cb) => {
                const step =
                  ({ "1D": 86400, "1W": 604800, "1M": 2592000 }[r] ||
                    Number(r) * 60) * 1000;
                const end = Math.floor((p.to * 1000) / step) * step;
                const bars = Array.from({ length: p.countBack }, (_, i) => ({
                  time: end - (p.countBack - i) * step,
                  open: 100,
                  high: 102,
                  low: 99,
                  close: 101,
                }));
                setTimeout(() => cb(bars, { noData: false }), 0);
              };
              feed.subscribeBars = () => {};
              feed.unsubscribeBars = () => {};
              return Reflect.construct(target, [options], target);
            },
          });
        });
      });
      preferences = [];
      row = {
        id: "refresh-regression",
        name: item.name,
        revision: 0,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          symbol: "MWP:XAUUSD",
          series_kind: "provider",
          interval: "5",
        },
      };
      await page.goto(origin + "/parent");
      let frame = await settle(page);
      assert.deepEqual(
        await current(frame),
        [{ symbol: "MWP:XAUUSD", resolution: "5" }],
        "never-saved workspace still initializes its configured symbol",
      );
      await frame.evaluate(async (symbols) => {
        if (symbols.length > 1)
          await widget.setLayout(
            symbols.length === 2 ? "2h" : String(symbols.length),
          );
        widget.symbolSync().setValue(false);
        widget.intervalSync().setValue(false);
        widget.timeSync().setValue(false);
        widget.dateRangeSync().setValue(false);
        const resolutions = ["240", "60", "1D", "5", "1W", "30", "15", "1M"];
        for (let i = 0; i < symbols.length; i++) {
          await widget
            .chart(i)
            .setSymbol(symbols[i], { doNotActivateChart: true });
          await widget
            .chart(i)
            .setResolution(resolutions[i], { doNotActivateChart: true });
        }
        widget.setActiveChart(symbols.length - 1);
      }, item.symbols);
      await settle(page);
      const shape = await frame.evaluate(() =>
        widget
          .chart(0)
          .createShape(
            { price: 101, time: widget.chart(0).getVisibleRange().to },
            { shape: "horizontal_line" },
          ),
      );
      const extraShapes = await frame.evaluate(async () => {
        const chart = widget.chart(0), range = chart.getVisibleRange();
        const anchors = [{price: 100, time: range.to - 3600 * 8}, {price: 102, time: range.to - 3600 * 4}];
        const trend = await chart.createMultipointShape(anchors, {shape: "trend_line"});
        const region = await chart.createMultipointShape(anchors, {shape: "rectangle"});
        return [trend, region];
      });
      await frame.evaluate(
        () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
      );
      const expected = await current(frame);
      const projection = row.document.state._mwDrawingProjection;
      assert.equal(projection.version, 1);
      assert.equal(projection.charts.length, expected.length);
      assert.deepEqual(projection.charts.map(c => ({symbol: c.symbol, resolution: c.resolution})), expected);
      const projectedShape = projection.charts[0].drawings.find(s => s.id === shape);
      assert.ok(projectedShape, "saved projection preserves native object identity");
      assert.deepEqual(projectedShape.points, await frame.evaluate(id =>
        widget.chart(0).getShapeById(id).getPoints().map(p => ({time: p.time ?? null, price: p.price})), shape));
      for (const id of extraShapes) {
        const projected = projection.charts[0].drawings.find(s => s.id === id);
        assert.ok(projected);
        assert.deepEqual(projected.points, await frame.evaluate(id =>
          widget.chart(0).getShapeById(id).getPoints().map(p => ({time: p.time ?? null, price: p.price})), id));
      }
      console.log("DRAWING_PROJECTION", JSON.stringify(projection));
      if (process.env.MW_DRAWING_PROJECTION_OUTPUT)
        fs.writeFileSync(process.env.MW_DRAWING_PROJECTION_OUTPUT, JSON.stringify(row.document));
      console.log(
        JSON.stringify({
          case: item.name,
          phase: "saved",
          expected,
          metadata: row.document.symbol,
          mainSeries: row.document.state.charts.map((c) =>
            c.panes
              .flatMap((p) => p.sources)
              .filter((s) => s.type === "MainSeries")
              .map((s) => s.state.symbol),
          ),
        }),
      );
      await page.reload();
      frame = await settle(page);
      const restored = await current(frame);
      console.log(
        JSON.stringify({ case: item.name, phase: "refreshed", restored }),
      );
      assert.deepEqual(
        restored,
        expected,
        "refresh must preserve saved instrument AND provider/managed identity",
      );
      assert.equal(
        row.document.symbol,
        expected[0].symbol,
        "save metadata must use the captured first chart ticker",
      );
      assert.equal(row.document.interval, expected[0].resolution);
      assert.ok(
        (await frame.evaluate(() => widget.chart(0).getAllShapes())).some(
          (s) => s.id === shape,
        ),
        "refresh keeps drawings",
      );
      // Prior releases already saved display-only/focused metadata. Recover raw
      // and legacy envelope layouts from their intact chart state without a rewrite.
      const stored = structuredClone(row.document.state);
      row.document.symbol = "EURUSD";
      row.document.series_kind = "managed";
      row.document.interval = "5";
      for (const envelope of [false, true]) {
        row.document.state = envelope
          ? { content: JSON.stringify(stored) }
          : structuredClone(stored);
        const original = JSON.stringify(row.document);
        const revision = row.revision;
        await page.reload();
        frame = await settle(page);
        assert.deepEqual(
          await current(frame),
          expected,
          "old display-only metadata must not override saved chart state",
        );
        assert.equal(
          JSON.stringify(row.document),
          original,
          "opening an old layout must not rewrite it",
        );
        assert.equal(row.revision, revision);
        assert.ok(
          (await frame.evaluate(() => widget.chart(0).getAllShapes())).some(
            (s) => s.id === shape,
          ),
        );
      }
      // Also exercise the existing native Load menu path with a raw legacy layout.
      row.document.state = structuredClone(stored);
      await frame.evaluate(
        () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
      );
      row.document.symbol = "EURUSD";
      row.document.series_kind = "managed";
      await frame.evaluate((meta) => widget.loadChartFromServer(meta), {
        id: row.id,
        name: row.name,
        symbol: "EURUSD",
        resolution: "5",
      });
      frame = await settle(page);
      assert.deepEqual(
        await current(frame),
        expected,
        "native layout load preserves each saved chart identity",
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(
        messages.filter((m) => m.type === "error"),
        [],
      );
      messages.length = 0;
      await page.close();
      console.log(
        JSON.stringify({
          case: item.name,
          passed: true,
          charts: item.symbols.length,
          legacy_formats: ["raw", "envelope"],
          native_load: true,
          drawings: true,
        }),
      );
    }
    console.log(
      "Layout save/refresh retains each chart series, resolution and drawings.",
    );
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
