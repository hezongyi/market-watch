const assert = require("node:assert/strict");
const fs = require("node:fs"),
  vm = require("node:vm");
const context = vm.createContext({
  globalThis: {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
});
vm.runInContext(
  fs.readFileSync(
    require("node:path").join(
      __dirname,
      "../../advanced-host/bar-range-mapping.js",
    ),
    "utf8",
  ),
  context,
);
const eligible = vm.runInContext("chartBarRangeMapping.eligible", context);
const periods = ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"];
for (const [a, source] of periods.entries())
  for (const [b, target] of periods.entries())
    assert.equal(
      eligible(source, target),
      a > b && !(source === "1M" && target === "1W"),
      source + "→" + target,
    );
assert.equal(eligible("R", "1"), false);
const create = vm.runInContext("chartBarRangeMapping", context);
let edits = 0;
const mapper = create({
  initial: { version: 99, enabled: true, style: "oops" },
  changed: () => edits++,
});
assert.deepEqual(JSON.parse(JSON.stringify(mapper.snapshot())), {
  version: 2,
  enabled: false,
  style: "background",
  colorMode:"theme",color:"#FFFFFF",transparencyMode:"theme",transparency:88,priceLabels:true,
});
mapper.configure({ enabled: true, style: "rectangle" });
assert.equal(edits, 1);
mapper.configure({ enabled: true, style: "rectangle" });
assert.equal(edits, 1);
mapper.configure({ enabled: false }, true);
assert.equal(edits, 1);
mapper.observeBars({
  symbol: "MWP:EURUSD",
  resolution: "1D",
  bars: [
    {
      chart_time: 100,
      start: 80,
      end: 160,
      high: "2",
      low: "1",
      complete: true,
    },
  ],
});
assert.equal(mapper.diagnostics().stores[0].size, 1);
mapper.invalidate("MWP:EURUSD", "1D");
assert.equal(mapper.diagnostics().stores.length, 0);
const ticket = mapper.capture("MWP:EURUSD", "1D");
mapper.invalidate("MWP:EURUSD", "1D");
mapper.observeBars({
  symbol: "MWP:EURUSD",
  resolution: "1D",
  ticket,
  bars: [{ chart_time: 100, start: 80, end: 160, high: 2, low: 1 }],
});
assert.equal(
  mapper.diagnostics().stores.length,
  0,
  "old generation resurrected metadata",
);
mapper.dispose();
mapper.dispose();
mapper.observeBars({
  symbol: "x",
  resolution: "5",
  bars: [{ chart_time: 100, start: 100, end: 400, high: 2, low: 1 }],
});
assert.equal(mapper.diagnostics().stores.length, 0);
const readOnly = create({ readonly: true, changed: () => edits++ });
readOnly.configure({ enabled: true });
assert.equal(edits, 1);
readOnly.dispose();
console.log(
  "Range rules, validation, configuration, invalidation and disposal passed",
);
// Exercise the real module interface with native coordinate adapters: fractional
// boundaries, clipping, source feedback, real high/low updates and stale data.
{
  const event = () => {
    const callbacks = new Set();
    return {
      subscribe: (_, fn) => callbacks.add(fn),
      unsubscribe: (_, fn) => callbacks.delete(fn),
      fire: () => callbacks.forEach((fn) => fn()),
    };
  };
  const docListeners = new Map(),
    queues = new Map();
  let sequence = 0,
    hover = 0;
  const canvas = {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    }),
  };
  const doc = {
    addEventListener: (name, fn) => docListeners.set(name, fn),
    removeEventListener: () => {},
    elementFromPoint: () => ({ tagName: "CANVAS" }),
    defaultView: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  const charts = [];
  let paints = [];
  for (const [symbol, res] of [
    ["MWP:EURUSD", "1D"],
    ["MWP:EURUSD", "5"],
    ["MWP:EURUSD", "1W"],
    ["EURUSD", "1"],
  ]) {
    const rows = {
      firstIndex: () => 0,
      lastIndex: () => 1,
      contains: (i) => i === 0 || i === 1,
    };
    const ts = {
      coordinateToIndex: () => hover,
      coordinateToFloatIndex: (x) => x / 10,
      barSpacing: () => 10,
      width: () => 100,
      indexToCoordinate: (i) => i * 10 + 5,
      points: () => ({
        valueAt: (i) => (i >= 0 && i < 2 ? i * 300 : null),
        range: () => ({ value: () => ({ firstIndex: 0, lastIndex: 1 }) }),
        roughTime: (i) => i * 300,
      }),
    };
    const m = {
      lightUpdate: () => {},
      timeScale: () => ts,
      mainSeries: () => ({
        bars: () => rows,
        syncModel: () => ({
          isValid: () => true,
          projectTime: (t) => t,
          mwRangeSlot: (t) => ({ start: t, end: t + 300000 }),
        }),
        priceScale: () => ({
          isEmpty: () => false,
          priceToCoordinate: (p) => 100 - p * 10,
        }),
        firstValue: () => 1,
      }),
    };
    const pane = {
      containsMainSeries: () => true,
      canvasElement: () => canvas,
      state: () => ({ model: () => m }),
      height: () => 100,
    };
    const c = {
      symbol: () => symbol,
      resolution: () => res,
      chartType: () => 1,
      dataReady: () => true,
      _getTimeConverter: () => ({ convertInternalTimeToPublicTime: (t) => t }),
      _convertIndexToPublicTime: (i) => i * 300,
      onSymbolChanged: event,
      onIntervalChanged: event,
      onVisibleRangeChanged: event,
      onDataLoaded: event,
      crossHairMoved: event,
      _chartWidget: {
        model: () => ({ model: () => m }),
        ownerDocument: () => doc,
        paneWidgets: () => [pane],
      },
    };
    c.pane = pane;
    charts.push(c);
  }
  const sync = {
    value: () => true,
    subscribe: () => {},
    unsubscribe: () => {},
  };
  const w = {
    chartsCount: () => charts.length,
    chart: (i) => charts[i],
    crosshairSync: () => sync,
    getTheme: () => "Light",
  };
  context.MWSeries = { same: (a, b) => a === b };
  const mapper = create({
    widget: w,
    frame: (fn) => {
      const id = ++sequence;
      queues.set(id, fn);
      return id;
    },
    cancelFrame: (id) => queues.delete(id),
  });
  mapper.refreshCharts();
  mapper.configure({ enabled: true,priceLabels:false });
  mapper.observeBars({
    symbol: "MWP:EURUSD",
    resolution: "1D",
    bars: [{ chart_time: 0, start: 150000, end: 450000, high: 8, low: 2 }],
  });
  mapper.observeBars({
    symbol: "MWP:EURUSD",
    resolution: "5",
    bars: [
      { chart_time: 0, start: 0, end: 300000, high: 8, low: 2 },
      { chart_time: 300000, start: 300000, end: 600000, high: 8, low: 2 },
    ],
  });
  const flush = () => {
    const callbacks = [...queues.values()];
    queues.clear();
    callbacks.forEach((fn) => fn());
  };
  flush();
  // Native idle purge clears Thread cache without deleting the Thread object.
  // Only live panes or a real remaining cache range retain metadata/tickets.
  context.globalThis.MWNativeReserve = {acceptedRanges:()=>[
    {symbol:'MWP:OLD',resolution:'1D',from:undefined,to:undefined},
    {symbol:'MWP:RETAINED',resolution:'1D',from:0,to:100},
  ]};
  const oldTicket = mapper.capture('MWP:OLD','1D');
  for(const symbol of ['MWP:OLD','MWP:RETAINED'])
    mapper.observeBars({symbol,resolution:'1D',bars:[{chart_time:0,start:0,end:100,high:2,low:1}]});
  mapper.cachePurged(); flush();
  assert.ok(!mapper.diagnostics().stores.some(s=>s.key==='MWP:OLD|1D|'),'empty obsolete thread must release metadata');
  assert.notEqual(mapper.capture('MWP:OLD','1D'),oldTicket,'purged source releases its old ticket');
  mapper.observeBars({symbol:'MWP:OLD',resolution:'1D',ticket:oldTicket,
    bars:[{chart_time:0,start:0,end:100,high:2,low:1}]});
  assert.ok(!mapper.diagnostics().stores.some(s=>s.key==='MWP:OLD|1D|'),'late purged ticket cannot resurrect obsolete metadata');
  assert.ok(mapper.diagnostics().stores.some(s=>s.key==='MWP:RETAINED|1D|'),'real cached range remains retained');
  assert.ok(mapper.diagnostics().stores.some(s=>s.key==='MWP:EURUSD|5|'),'live delivered bars survive cache purge');
  context.globalThis.MWNativeReserve = undefined;
  mapper.cachePurged(); flush();
  assert.ok(!mapper.diagnostics().stores.some(s=>s.key==='MWP:RETAINED|1D|'),'last cached source releases on unbind');
  context.MWSeries.decode = symbol => ({symbol:symbol.startsWith('MWPY:') ? 'RETAINED' : symbol.slice(4),series_kind:'provider',
    ...(symbol.startsWith('MWPY:') ? {spec:{name:'SMA'}} : {})});
  context.MWSeries.encode = symbol => 'MWP:'+symbol;
  context.globalThis.MWNativeReserve = {acceptedRanges:()=>[
    {symbol:'MWP:RETAINED',resolution:'1D',from:0,to:100},
    {symbol:'MWPY:RETAINED',resolution:'1D',from:100,to:100},
    {symbol:'MWP:EURUSD',resolution:'5',from:300000,to:300000},
  ]};
  mapper.observeBars({symbol:'MWP:RETAINED',resolution:'1D',bars:[0,100].map(t=>({chart_time:t,start:t,end:t+100,high:2,low:1}))});
  mapper.cachePurged(); flush();
  assert.equal(mapper.diagnostics().stores.find(s=>s.key==='MWP:RETAINED|1D|').size,2,
    'Python study cache must not narrow base metadata');
  assert.equal(mapper.diagnostics().stores.find(s=>s.key==='MWP:EURUSD|5|').size,2,
    'live delivered range is unioned with narrower cached range');
  context.globalThis.MWNativeReserve = undefined;
  docListeners.get("pointermove")({
    pointerType: "mouse",
    clientX: 5,
    clientY: 50,
    target: { tagName: "CANVAS", closest: () => false },
  });
  flush();
  assert.equal(mapper.diagnostics().source.start, 150000);
  const ctx = {
    save: () => {},
    scale: () => {},
    fillRect: (...r) => paints.push(r),
    restore: () => {},
  };
  const info = {
    bitmapSize: { width: 100, height: 100 },
    mediaSize: { width: 100, height: 100 },
  };
  mapper.draw(charts[1].pane, ctx, info);
  assert.deepEqual(
    paints,
    [[5, 0, 10, 100]],
    "fractional half-bar intersection",
  );
  charts[1].chartType = () => 4;
  paints = [];
  mapper.draw(charts[1].pane, ctx, info);
  assert.deepEqual(paints, [], "synthetic target painted");
  charts[1].chartType = () => 1;
  mapper.draw(charts[1].pane, ctx, info);
  mapper.draw(charts[2].pane, ctx, info);
  mapper.draw(charts[3].pane, ctx, info);
  assert.equal(paints.length, 1, "larger period or managed identity painted");
  mapper.configure({ style: "rectangle" });
  docListeners.get("pointermove")({
    clientX: 5,
    clientY: 50,
    target: { tagName: "CANVAS", closest: () => false },
  });
  flush();
  paints = [];
  mapper.draw(charts[1].pane, ctx, info);
  assert.deepEqual(paints, [[5, 20, 10, 60]]);
  mapper.observeBars({
    symbol: "MWP:EURUSD",
    resolution: "1D",
    bars: [{ chart_time: 0, start: 150000, end: 450000, high: 9, low: 1 }],
  });
  flush();
  paints = [];
  mapper.draw(charts[1].pane, ctx, info);
  assert.deepEqual(paints, [[5, 10, 10, 80]], "realtime high/low not applied");
  mapper.invalidate("MWP:EURUSD", "1D");
  paints = [];
  mapper.draw(charts[1].pane, ctx, info);
  assert.deepEqual(paints, []);
  mapper.dispose();
  console.log(
    "Fractional pixel bounds, price projection, identity filtering and realtime invalidation passed",
  );
}

const identityContext = vm.createContext({
  globalThis: {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
});
vm.runInContext(
  fs.readFileSync(
    require("node:path").join(__dirname, "../../advanced-host/series.js"),
    "utf8",
  ),
  identityContext,
);
vm.runInContext(
  fs.readFileSync(
    require("node:path").join(
      __dirname,
      "../../advanced-host/bar-range-mapping.js",
    ),
    "utf8",
  ),
  identityContext,
);
const canonical = vm.runInContext("chartBarRangeMapping({})", identityContext);
const ident = "MWP:YAHOO:6493341e6b5636b2080fa9a1961f4fd3";
const canonicalTicket = canonical.capture(ident.toUpperCase(), "1D");
canonical.observeBars({
  symbol: ident,
  resolution: "1D",
  ticket: canonicalTicket,
  bars: [{ chart_time: 100, start: 80, end: 160, high: 2, low: 1 }],
});
assert.equal(canonical.diagnostics().stores.length, 1);
canonical.invalidate(ident.toUpperCase(), "1D");
assert.equal(canonical.diagnostics().stores.length, 0);
canonical.dispose();
console.log("Canonical Yahoo series identity passed");
