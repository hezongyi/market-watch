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
        inverted = event(),
        height = event(),
        data = event(),
        changed = event(),
        symbol = event(),
        interval = event(),
        visible = event();
      let y = 80,
        rangeShift = 0,
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
          if (first !== 100)
            throw Error("wrong native coordinate inputs");
          return price === 1.11951 ? y : 120 + (105 - price) * 10 + rangeShift;
        },
        priceRangeChanged: () => range,
        modeChanged: () => mode,
        properties: () => ({ childs: () => ({ isInverted: inverted }) }),
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
                    : k === "colors"
                      ? o.colors
                    : k === "editable"
                      ? o.editable
                    : k === "setEditable"
                      ? value => {o.editable=value;return line;}
                    : k === "setLineColor"
                      ? color => { (o.colors ||= []).push(color); return line; }
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
      const edits=[];
      let rangeSaved, rangeWrites=0;
      const adapter = nativeAlertPriceLines({
        current: (row, chart, captured) => captured === epoch,
        archive: async (row) => {
          archives.push(row.version);
          if (fail) throw Error("conflict");
        },
        edit: row => edits.push(row.id),
        action: async (row, action) => {
          rangeWrites++;
          rangeSaved={...row,status:action==='resume'?'active':'paused',control_revision:row.control_revision+1};
          throw Object.assign(Error('lost lifecycle response'),{outcomeUnknown:true});
        },
        read: async () => rangeSaved,
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
      inverted.fire();
      await frame();
      expect(
        parseFloat(label.style.top) === 280,
        "mode/axis coordinate changes use actual native mapping",
      );
      document.querySelector('button[aria-label^="结束告警"]').click();
      await frame();
      expect(
        label.isConnected && !lines[0].removed,
        "failed archive preserves primitive and label",
      );
      expect(
        reports.some((x) => x.includes("操作未完成")),
        "failed archive is explained",
      );
      fail = false;
      sync({ ...row, version: 2, control_revision: 2 });
      await frame();
      document.querySelector('button[aria-label^="结束告警"]').click();
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
      const beforeRange=lines.length;
      const rangeRow={...row,name:"EURUSD 前日高低突破",config:{condition:{relation:"exit",left:{kind:"price"},lower:"100",upper:"110"},timeframe:"M5",series_kind:"composite"}};
      sync(rangeRow);await frame();
      const rangeLabel=document.querySelector('[data-name="mw-alert-range-label"]');
      expect(lines.length===beforeRange+2,"one rule creates two native boundaries");
      expect(lines.slice(beforeRange).every(line=>line.editable===false),"neither boundary can be dragged to change its reference price");
      expect(rangeLabel&&rangeLabel.textContent==="前日高低 · M5","one compact shared label names its confirmation period");
      expect(Math.abs(parseFloat(rangeLabel.style.top)-(20+70))<1,"shared tag follows the visible upper boundary");
      rangeLabel.click();await frame();document.querySelector('[data-name="mw-alert-range-actions"]').querySelectorAll('button')[1].click();expect(edits.join(",")==="rule","either range is managed through the one rule");
      sync({...rangeRow,status:"paused"});await frame();
      expect(rangeLabel.textContent==="Ⅱ 前日高低 · M5","paused range is clearly marked");
      expect(lines.slice(beforeRange).every(line=>line.colors?.includes("#969da8")||line.colors?.includes("#787f8c")),"both paused boundaries use the same muted color: "+JSON.stringify(lines.slice(beforeRange).map(line=>line.colors)));
      rangeLabel.click();await frame();
      const rangeActions=document.querySelector('[data-name="mw-alert-range-actions"]');
      const rangeButtons=rangeActions.querySelectorAll('button');
      rangeButtons[0].click();await frame();
      expect(rangeButtons[0].disabled&&!rangeButtons[3].hidden,"uncertain lifecycle disables duplicate writes and offers verification");
      sync(rangeSaved);await frame();
      rangeButtons[3].click();await frame();
      expect(!rangeButtons[0].disabled&&rangeButtons[3].hidden&&rangeWrites===1,"polling a committed revision does not prevent readback from clearing uncertainty");
      sync({...rangeSaved,name:"EURUSD 普通区间"});await frame();
      expect(rangeLabel.textContent==="区间告警 · M5","ordinary exit rules are not described as a previous-day preset");
      expect([...document.querySelectorAll('[data-name="mw-alert-range-boundary"] span')].map(v=>v.textContent).join(',')==='下沿,上沿',"ordinary ranges use neutral boundary captions");
      rangeShift=400;range.fire();await frame();
      expect(rangeLabel.style.display==="none","range tag hides when neither bound is visible, without changing scale");
      sync({...rangeRow,status:"completed"});await frame();
      expect(!document.querySelector('[data-name="mw-alert-range-label"]'),"completed range leaves the active chart");
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
