// Shared isolated-product setup and native coordinate observations.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
module.exports = async function rangeFixture({ browser, report, APP, CHART }) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  const response = await ctx.request.post(APP + "/api/login", {
    data: JSON.parse(
      fs.readFileSync(
        process.env.RANGE_LOGIN ||
          "/tmp/mw-range-mapping-acceptance/login.json",
      ),
    ),
  });
  assert.ok(response.ok());
  const csrf = (await response.json()).csrf;
  const api = async (endpoint, data) => {
    const r = await ctx.request.post(APP + "/api/" + endpoint, {
      headers: { "X-CSRF-Token": csrf },
      data,
    });
    assert.ok(r.ok(), endpoint + " " + r.status());
    return r.json();
  };
  const w = await api("advanced-charts/workspaces", {
    name: "Range mapping browser acceptance",
  });
  await api(`advanced-charts/workspaces/${w.id}/save`, {
    name: w.name,
    revision: w.revision,
    document: {
      engine: "tv31",
      schemaVersion: 1,
      symbol: process.env.RANGE_SYMBOL || "MWP:EURUSD",
      series_kind: "provider",
      interval: "1M",
    },
  });
  await ctx.route(
    "**/api/advanced-charts/workspaces?limit=1",
    async (route) => {
      const r = await ctx.request.get(APP + "/api/advanced-charts/workspaces");
      const rows = await r.json();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows.filter((r) => r.id === w.id)),
      });
    },
  );
  const page = await ctx.newPage();
  page.on("pageerror", (e) => report.errors.push(e.stack || e.message || String(e)));
  let history = 0;
  page.on("request", (r) => {
    if (/\/api\/charts\/(data|reserve|history-loads)$/.test(r.url()) && r.method() === "POST") history++;
  });
  await page.goto(APP + "/advanced-charts");
  let host;
  for (let n = 0; n < 300 && !host; n++) {
    host = page.frames().find((f) => f.url().startsWith(CHART + "/"));
    if (!host) await page.waitForTimeout(100);
  }
  assert.ok(host);
  const settle = async () => {
    try { await host.waitForFunction(
      () =>
        typeof ready !== "undefined" &&
        ready &&
        !loading &&
        !MWNativeNavigation.busy() &&
        !rangeGuard.busy() &&
        !edgeGuard.busy() &&
        Array.from({ length: widget.chartsCount() }, (_, i) =>
          widget.chart(i).dataReady(),
        ).every(Boolean),
      null,
      { timeout: 60000 },
    ); } catch (error) {
      report.settleFailure = await host.evaluate(() => ({
        ready, loading, historyReloading, dirty, nativeSaving,
        navigation: MWNativeNavigation.diagnostics(),
        navigationBusy: MWNativeNavigation.busy(),
        rangeBusy: rangeGuard?.busy(), edgeBusy: edgeGuard?.busy(),
        edge: edgeGuard?.diagnostics?.(),
        synchronization: MWSyncCoordinator.diagnostics(),
        legacyPause: !!widget._mwLegacyPause,
        charts: Array.from({ length: widget.chartsCount() }, (_, i) => ({
          ready: widget.chart(i).dataReady(),
          resolution: widget.chart(i).resolution(),
          range: widget.chart(i).getVisibleRange(),
        })),
      })).catch(() => null);
      throw error;
    }
  };
  await settle();
  await host.evaluate(() => {
    widget.timeSync().setValue(false);
    widget.dateRangeSync().setValue(false);
    widget.crosshairSync().setValue(true);
    widget.setLayout("4");
  });
  await settle();
  await host.evaluate(async () => {
    for (const [i, r] of [
      [0, "1M"],
      [1, "1D"],
      [2, "5"],
      [3, "1W"],
    ])
      await widget.chart(i).setResolution(r, { doNotActivateChart: true });
  });
  await settle();
  const native = page.frames().find((f) => f.parentFrame() === host);
  // Observe actual paint rectangles without injecting selection or callbacks.
  await host.evaluate(() => {
    globalThis.__rangePaints = [];
    const draw = MWBarRangeMapping.draw;
    MWBarRangeMapping.draw = function (p, c, i) {
      const fill = c.fillRect;
      c.fillRect = function (...rect) {
        if (__rangePaints.length >= 400) __rangePaints.shift();
        __rangePaints.push({
          id: p.state().model().id(),
          resolution: p.state().model().interval(),
          rect,
          at: performance.now(),
        });
        return fill.apply(this, rect);
      };
      try {
        return draw(p, c, i);
      } finally {
        c.fillRect = fill;
      }
    };
  });
  await native.getByRole("button", { name: "布局设置", exact: true }).click();
  await native.locator('[data-name="mw-bar-range-mapping"]').waitFor();
  assert.equal(
    await native
      .locator('[data-name="mw-bar-range-mapping"]')
      .getAttribute("aria-checked"),
    "false",
  );
  await native.locator('[data-name="mw-bar-range-mapping"]').click();
  await native.getByRole("button", { name: "布局设置", exact: true }).click();
  const box = async (i) => {
    const b = await host.evaluate((i) => {
      const p = widget
        .chart(i)
        ._chartWidget.paneWidgets()
        .find((p) => p.containsMainSeries());
      const r = p.canvasElement().getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, i);
    const root = await native.frameElement().then((e) => e.boundingBox());
    return {
      x: b.x + root.x,
      y: b.y + root.y,
      width: b.width,
      height: b.height,
    };
  };
  const hoverLast = async (i) => {
    await page.mouse.move(10,10);
    const b = await box(i);
    const x = await host.evaluate((i) => {
      const m = widget.chart(i)._chartWidget.model().model();
      const scale = m.timeScale(),bars = m.mainSeries().bars();
      // Continuous history can keep newer bars outside a historical viewport.
      // Use a real loaded bar on the visible canvas, never an offscreen point.
      const index = Math.min(bars.lastIndex(),Math.floor(scale.visibleBarsStrictRange().lastBar()));
      if(index < bars.firstIndex()) throw Error('no loaded bar in visible viewport');
      return scale.indexToCoordinate(index);
    }, i);
    await page.mouse.move(b.x + x, b.y + b.height * 0.55);
    await page.waitForTimeout(200);
    report.lastHover = await host.evaluate(({i,x}) => {
      const c=widget.chart(i),m=c._chartWidget.model().model(),p=c._chartWidget.paneWidgets().find(p=>p.containsMainSeries());
      const r=p.canvasElement().getBoundingClientRect(),y=r.y+r.height*.55,index=m.timeScale().coordinateToIndex(x);
      const hit=p.canvasElement().ownerDocument.elementFromPoint(r.x+x,y);
      return {i,x,y,index,contains:m.mainSeries().bars().contains(index),time:c._convertIndexToPublicTime(index),
        hit:hit && {tag:hit.tagName,role:hit.getAttribute('role'),name:hit.getAttribute('data-name'),text:hit.tagName==='CANVAS'?'':hit.textContent.slice(0,100)},
        lastIndex:m.mainSeries().bars().lastIndex(),source:MWBarRangeMapping.diagnostics().source};
    },{i,x});
  };
  const state = () =>
    host.evaluate(() => ({
      mapper: MWBarRangeMapping.diagnostics(),
      paints: __rangePaints.slice(-20),
      config: MWBarRangeMapping.snapshot(),
      dirty,
      marketSignatures: Array.from({length:widget.chartsCount()},(_,i) => {
        const m=widget.chart(i)._chartWidget.model().model(), bars=m.mainSeries().bars();
        const visible=m.timeScale().visibleBarsStrictRange(), values=[];
        if(visible) for(let n=Math.max(bars.firstIndex(),Math.ceil(visible.firstBar()));
          n<=Math.min(bars.lastIndex(),Math.floor(visible.lastBar()));n++)
          values.push(bars.valueAt(n));
        return JSON.stringify(values);
      }),
      charts: Array.from({ length: widget.chartsCount() }, (_, i) => {
        const c = widget.chart(i),
          t = c.getTimeScale(),
          p = c
            .getPanes()
            .find((p) => p.hasMainSeries())
            .getMainSourcePriceScale();
        return {
          symbol: c.symbol(),
          resolution: c.resolution(),
          range: c.getVisibleRange(),
          spacing: t.barSpacing(),
          offset: t.rightOffset(),
          price: p.getVisiblePriceRange(),
          shapes: c.getAllShapes(),
        };
      }),
    }));
  // Background reserves can finish after dataReady. Establish an idle network
  // baseline before asserting hover itself adds no history request or mutation.
  const idle = async () => {
    const deadline = Date.now() + 60000;
    let previous;
    while (Date.now() < deadline) {
      await settle();
      await host.waitForFunction(() => {
        const d = MWNativeReserve.diagnostics();
        return d.flights === 0 && d.threads.every(t => !t.requesting);
      }, null, {timeout:60000});
      const current = JSON.stringify({history, charts:(await state()).charts});
      if (current === previous) return;
      previous = current;
      await page.waitForTimeout(700);
    }
    assert.fail("history and chart setup did not become idle before hover");
  };
  return {
    ctx,
    api,
    w,
    page,
    native,
    host,
    settle,
    idle,
    box,
    hoverLast,
    state,
    get history() {
      return history;
    },
    setHost(value) {
      host = value;
    },
  };
};
