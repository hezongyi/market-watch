// Contract regression with real DOM and controlled native events, not a licensed-chart acceptance.
const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<canvas width="600" height="400" style="position:absolute;left:30px;top:20px;width:600px;height:400px"></canvas>',
    );
    await page.addScriptTag({
      content: fs.readFileSync(
        "../advanced-host/native-alert-price-lines.js",
        "utf8",
      ),
    });
    const result = await page.evaluate(async () => {
      globalThis.TradingView = {
        version: () => "v31.1.0 6b804c486857f27920cf761aa7eb6e29d9bb6362",
      };
      const subscriptions = new Set();
      const event = () => ({
        listeners: new Map(),
        subscribe(owner, fn) {
          this.listeners.set(owner, fn);
          subscriptions.add(fn);
        },
        unsubscribe(owner, fn) {
          this.listeners.delete(owner);
          subscriptions.delete(fn);
        },
        fire() {
          for (const fn of [...this.listeners.values()]) fn();
        },
      });
      const range = event(),
        mode = event(),
        height = event(),
        data = event(),
        changed = event(),
        symbol = event(),
        interval = event(),
        visible = event();
      let y = 80,
        epoch = 1,
        hold = false,
        fail = true;
      const deferred = [],
        lines = [],
        archives = [],
        reports = [];
      const scale = {
        isEmpty: () => false,
        priceToCoordinate: (price, first) => {
          if (price !== 1.11951 || first !== 100)
            throw Error("wrong native coordinate inputs");
          return y;
        },
        priceRangeChanged: () => range,
        modeChanged: () => mode,
        internalHeightChanged: () => height,
      };
      const series = {
        priceScale: () => scale,
        firstValue: () => 100,
        dataEvents: () => ({ dataUpdated: () => data }),
        priceScaleChanged: () => changed,
      };
      const chart = {
        _chartWidget: {
          model: () => ({ model: () => ({ mainSeries: () => series }) }),
          paneWidgets: () => [
            {
              containsMainSeries: () => true,
              canvasElement: () => document.querySelector("canvas"),
            },
          ],
        },
        dataReady: () => true,
        onVisibleRangeChanged: () => visible,
        onSymbolChanged: () => symbol,
        onIntervalChanged: () => interval,
        async createOrderLine() {
          const target = { removed: false };
          const line = new Proxy(target, {
            get: (o, k) =>
              k === "then"
                ? undefined
                : k === "remove"
                  ? () => {
                      o.removed = true;
                    }
                  : k === "removed"
                    ? o.removed
                    : () => line,
          });
          lines.push(line);
          if (hold) await new Promise((resolve) => deferred.push(resolve));
          return line;
        },
      };
      const row = {
        id: "rule",
        name: "EURUSD 穿过 1.11951",
        version: 1,
        control_revision: 1,
        status: "active",
        config: {
          condition: {
            left: { kind: "price" },
            right: { kind: "constant", value: "1.11951" },
            relation: "cross",
          },
          association: { workspace_id: "fixture" },
        },
        runtime: {},
      };
      const adapter = nativeAlertPriceLines({
        current: (row, chart, captured) => captured === epoch,
        archive: async (row) => {
          archives.push(row.version);
          if (fail) throw Error("conflict");
        },
        report: (row, text) => reports.push(text),
      });
      const sync = (rowValue = row) =>
        adapter.sync([{ row: rowValue, chart, epoch }]);
      const frame = () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      const expect = (ok, label) => {
        if (!ok) throw Error(label);
      };
      sync();
      await frame();
      const label = document.querySelector(
        '[data-name="mw-alert-price-label"]',
      );
      expect(label, "label exists");
      expect(
        Math.abs(parseFloat(label.style.top) - (20 + y)) < 1,
        "uses pane + native price coordinate",
      );
      y = 260;
      mode.fire();
      await frame();
      expect(
        parseFloat(label.style.top) === 280,
        "mode/axis coordinate changes use actual native mapping",
      );
      document.querySelector("button").click();
      await frame();
      expect(
        label.isConnected && !lines[0].removed,
        "failed archive preserves primitive and label",
      );
      expect(
        reports.some((x) => x.includes("删除未确认")),
        "failed archive is explained",
      );
      fail = false;
      sync({ ...row, version: 2, control_revision: 2 });
      await frame();
      document.querySelector("button").click();
      await frame();
      expect(
        archives.join(",") === "1,2",
        "archive uses latest confirmed revision",
      );
      expect(
        !document.querySelector('[data-name="mw-alert-price-label"]') &&
          lines[0].removed,
        "successful archive removes both",
      );
      hold = true;
      sync();
      await Promise.resolve();
      epoch++;
      adapter.clear();
      deferred.splice(0).forEach((fn) => fn());
      await frame();
      expect(
        !document.querySelector('[data-name="mw-alert-price-label"]'),
        "stale primitive cannot attach",
      );
      expect(
        lines.every((line) => line.removed),
        "all stale primitives released",
      );
      hold = false;
      sync({
        ...row,
        config: {
          condition: {
            left: { kind: "price" },
            right: { kind: "constant", value: "1.11951" },
            relation: "cross_up",
            offset: { kind: "atr" },
          },
        },
        runtime: {},
      });
      await frame();
      expect(
        adapter.diagnostics().entries === 0,
        "unknown ATR runtime threshold is not drawn",
      );
      sync({
        ...row,
        config: {
          condition: {
            left: { kind: "indicator" },
            right: { kind: "constant", value: "1.11951" },
            relation: "cross",
          },
        },
      });
      await frame();
      expect(
        adapter.diagnostics().entries === 0,
        "indicator units are not drawn as price",
      );
      sync();
      await frame();
      symbol.fire();
      await frame();
      expect(
        adapter.diagnostics().entries === 0,
        "symbol change releases line",
      );
      adapter.destroy();
      expect(subscriptions.size === 0, "all native subscriptions are released");
      return { archives, reports, lines: lines.length };
    });
    assert.deepEqual(result.archives, [1, 2]);
    console.log(
      "PASS price-line contract: native geometry, failure retention, latest revision, stale async fence, unit/ATR filter and disposal",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
