// Real pointer events and DOM, controlled native scale/API; no acceptance instance.
const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let frame;
  try {
    await page.setContent(
      '<iframe style="position:fixed;inset:0;width:100%;height:100%;border:0" srcdoc="<!doctype html><canvas style=&quot;position:absolute;left:30px;top:20px;width:600px;height:400px&quot;></canvas>"></iframe>',
    );
    frame = page.frames().find((f) => f !== page.mainFrame());
    await frame.setContent(
      '<canvas style="position:absolute;left:30px;top:20px;width:600px;height:400px"></canvas>',
    );
    await frame.addScriptTag({
      content: fs.readFileSync("../advanced-host/price-format.js", "utf8"),
    });
    await frame.addScriptTag({
      content: fs.readFileSync(
        "../advanced-host/native-alert-price-lines.js",
        "utf8",
      ),
    });
    await frame.evaluate(() => {
      globalThis.TradingView = {
        version: () => "v31.1.0 6b804c486857f27920cf761aa7eb6e29d9bb6362",
      };
      const event = () => ({ subscribe() {}, unsubscribe() {} });
      let adapter,
        epoch = 1,
        release;
      const t = (globalThis.t = {
        writes: [],
        notes: [],
        lines: [],
        mode: "success",
        inverted: false,
      });
      const scale = {
        isEmpty: () => false,
        priceToCoordinate: (p) => (t.inverted ? (p - 60) * 10 : (100 - p) * 10),
        coordinateToPrice: (y) => (t.inverted ? 60 + y / 10 : 100 - y / 10),
        priceRangeChanged: event,
        modeChanged: event,
        properties: () => ({ childs: () => ({ isInverted: event() }) }),
        internalHeightChanged: event,
      };
      const series = {
        priceScale: () => scale,
        firstValue: () => 1,
        dataEvents: () => ({ dataUpdated: event }),
        priceScaleChanged: event,
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
        priceFormatter: () => ({ format: (p) => p.toFixed(2) }),
        symbolExt: () => ({}),
        onVisibleRangeChanged: event,
        onSymbolChanged: event,
        onIntervalChanged: event,
        async createOrderLine() {
          const state = {
            price: 0,
            editable: false,
            removed: false,
            handlers: {},
          };
          const proxy = new Proxy(state, {
            get(o, k) {
              if (k === "then") return undefined;
              if (k === "getPrice") return () => o.price;
              if (k === "remove") return () => (o.removed = true);
              if (k === "setPrice")
                return (p) => {
                  o.price = p;
                  return proxy;
                };
              if (k === "setEditable")
                return (v) => {
                  o.editable = v;
                  return proxy;
                };
              if (["onMove", "onMoving"].includes(k))
                return (fn) => {
                  o.handlers[k] = fn;
                  return proxy;
                };
              if (k in o) return o[k];
              return () => proxy;
            },
          });
          t.lines.push(proxy);
          return proxy;
        },
      };
      t.start = (options = {}) => {
        adapter?.destroy();
        t.writes = [];
        t.notes = [];
        t.mode = "success";
        t.lines = [];
        t.inverted = !!options.inverted;
        t.row = {
          id: "r",
          version: 1,
          control_revision: 1,
          status: "active",
          name: "EURUSD 上穿 80.00",
          config: {
            condition: {
              left: { kind: "price" },
              right: { kind: "constant", value: "80.00" },
              relation: "cross_up",
              ...(options.offset ? { offset: { kind: "atr" } } : {}),
            },
            association: { object_kind: null },
          },
          runtime: options.offset ? { offset: { threshold: "80.00" } } : {},
        };
        adapter = nativeAlertPriceLines({
          current: (r, c, e) => e === epoch,
          readonly: !!options.readonly,
          archive: async () => {},
          report: (r, text) => t.notes.push(text),
          move: async (row, price) => {
            t.writes.push({ version: row.version, price });
            if (t.mode === "hold") await new Promise((r) => (release = r));
            if (t.mode === "fail") throw Error("version conflict");
            t.row = {
              ...t.row,
              version: row.version + 1,
              control_revision: row.control_revision + 1,
              config: {
                ...t.row.config,
                condition: {
                  ...t.row.config.condition,
                  right: { kind: "constant", value: price },
                },
              },
            };
            return structuredClone(t.row);
          },
        });
        adapter.sync([{ row: t.row, chart, epoch }]);
      };
      t.sync = () =>
        adapter.sync([{ row: structuredClone(t.row), chart, epoch }]);
      t.resolve = () => {
        t.mode = "success";
        release();
      };
      t.clear = () => {
        epoch++;
        adapter.clear();
      };
      t.native = (price, finish = false) => {
        const line = t.lines.at(-1);
        line.setPrice(price);
        line.handlers[finish ? "onMove" : "onMoving"]();
      };
      t.start();
    });
    const label = frame.locator('[data-name="mw-alert-price-label"]');
    async function down() {
      await label.waitFor();
      // Restoring the native price schedules its label position on the next
      // animation frame. Wait for that projection before sampling drag coords.
      await frame.waitForFunction(() => {
        const label = document.querySelector('[data-name="mw-alert-price-label"]');
        const canvas = document.querySelector("canvas");
        if (!label || !canvas) return false;
        const bounds = label.getBoundingClientRect();
        const price = t.lines.at(-1).getPrice();
        const y = canvas.getBoundingClientRect().top +
          (t.inverted ? (price - 60) * 10 : (100 - price) * 10);
        return Math.abs(bounds.top + bounds.height / 2 - y) < 0.5;
      });
      const b = await label.boundingBox();
      await page.mouse.move(b.x + 25, b.y + b.height / 2);
      await page.mouse.down();
      return b.y + b.height / 2;
    }
    async function moveBy(delta, up = true) {
      const y = await down();
      await page.mouse.move(61, y + delta, { steps: 5 });
      if (up) await page.mouse.up();
    }
    await moveBy(-40, false);
    assert.equal(
      await frame.evaluate(() => t.writes.length),
      0,
      "preview does not save",
    );
    await frame.evaluate(() => t.sync());
    assert.equal(await label.count(), 1, "polling retains active drag");
    await page.mouse.up();
    await frame.waitForFunction(() => t.row.version === 2);
    assert.deepEqual(await frame.evaluate(() => t.writes), [
      { version: 1, price: "84.00" },
    ]);
    let y = await down();
    await page.mouse.move(61, y - 30);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(
      await frame.evaluate(() => t.writes.length),
      1,
      "Escape cancels without save",
    );
    assert.equal(await frame.evaluate(() => t.lines.at(-1).getPrice()), 84);
    await frame.evaluate(() => (t.mode = "fail"));
    await moveBy(-20);
    await frame.waitForFunction(() =>
      t.notes.some((n) => n.includes("改价未确认")),
    );
    assert.equal(
      await frame.evaluate(() => t.lines.at(-1).getPrice()),
      84,
      "failed save restores last confirmed price",
    );
    await frame.evaluate(() => (t.mode = "hold"));
    await moveBy(-20);
    await frame.waitForFunction(() => t.writes.length === 3);
    assert.equal(await label.getAttribute("aria-busy"), "true");
    assert.equal(await label.locator("button").isDisabled(), true);
    assert.equal(await frame.evaluate(() => t.lines.at(-1).editable), false);
    await moveBy(-10);
    assert.equal(
      await frame.evaluate(() => t.writes.length),
      3,
      "busy drag cannot create another write",
    );
    await frame.evaluate(() => t.resolve());
    await frame.waitForFunction(() => t.row.version === 3);
    await frame.evaluate(() => t.native(90));
    assert.equal(await frame.evaluate(() => t.writes.length), 3);
    await frame.evaluate(() => t.native(90, true));
    await frame.waitForFunction(() => t.row.version === 4);
    assert.equal(
      await frame.evaluate(() => t.writes.at(-1).price),
      "90.00",
      "native line dragging uses same commit",
    );
    await frame.evaluate(() => {
      t.native(91);
    });
    await page.keyboard.press("Escape");
    await frame.evaluate(() => {
      t.native(92);
      t.native(92, true);
    });
    assert.equal(
      await frame.evaluate(() => t.writes.length),
      4,
      "Escape suppresses native drag completion",
    );
    for (const options of [{ readonly: true }, { offset: true }]) {
      await frame.evaluate((o) => t.start(o), options);
      await label.waitFor();
      await moveBy(-30);
      assert.equal(await frame.evaluate(() => t.writes.length), 0);
      assert.equal(await frame.evaluate(() => t.lines.at(-1).editable), false);
    }
    await frame.evaluate(() => t.start({ inverted: true }));
    await label.waitFor();
    await moveBy(30);
    await frame.waitForFunction(() => t.row.version === 2);
    assert.equal(
      await frame.evaluate(() => t.writes[0].price),
      "83.00",
      "native inverse coordinate mapping is used",
    );
    await frame.evaluate(() => (t.mode = "hold"));
    await moveBy(20);
    await frame.waitForFunction(() => t.writes.length === 2);
    await frame.evaluate(() => {
      t.clear();
      t.resolve();
    });
    await label.waitFor({ state: "detached" });
    assert.equal(
      await frame.locator('[data-name="mw-alert-price-dot"]').count(),
      0,
    );
    assert.ok(await frame.evaluate(() => t.lines.every((x) => x.removed)));
    assert.deepEqual(errors, []);
    console.log(
      "PASS alert price drag: real pointer preview/drop/Escape, failed/busy/versioned saves, native onMove, inverted scale, readonly/ATR and disposal",
    );
  } catch (e) {
    console.error(
      await frame.evaluate(() => ({
        notes: t.notes,
        body: document.body.innerHTML,
      })),
    );
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
