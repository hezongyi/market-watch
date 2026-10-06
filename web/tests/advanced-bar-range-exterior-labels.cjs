// Exercise the real range-mapping module through native coordinate/OHLC adapters.
// No browser, provider credentials, database or licensed bundle is required.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../../advanced-host/bar-range-mapping.js"),
  "utf8",
);
const cases = [];

function fixture({
  spacing = 20,
  origin = 40,
  width = 200,
  height = 200,
  sourceHigh = 100,
  sourceLow = 0,
  sourceStart = 0,
  sourceEnd = 4000,
  targetRows,
  nativeRows,
  project = (price) => 150 - price,
  legend,
  rowCount = 4,
} = {}) {
  const context = vm.createContext({
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    MWSeries: { same: (a, b) => a === b },
  });
  vm.runInContext(source, context);
  const listeners = new Map();
  const queue = new Map();
  let frameId = 0;
  let saved = 0;
  let restored = 0;
  const doc = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    elementFromPoint: () => ({ tagName: "CANVAS" }),
    defaultView: { addEventListener() {}, removeEventListener() {} },
  };
  const event = () => {
    const subscribers = new Set();
    return {
      subscribe: (_, fn) => subscribers.add(fn),
      unsubscribe: (_, fn) => subscribers.delete(fn),
    };
  };
  targetRows ??= Array.from({ length: rowCount }, (_, index) => ({
    chart_time: index * 1000,
    start: index * 1000,
    end: (index + 1) * 1000,
    high: index === 0 || index === 2 ? sourceHigh : sourceHigh - 20,
    low: index === 1 ? sourceLow : sourceLow + 20,
  }));
  // Native bars().valueAt(index) returns [time, open, high, low, close].
  nativeRows ??= Object.fromEntries(
    targetRows.map((row, index) => [
      index,
      [
        index,
        (row.high + row.low) / 2,
        row.high,
        row.low,
        (row.high + row.low) / 2,
      ],
    ]),
  );
  const charts = [];
  for (let chartIndex = 0; chartIndex < 2; chartIndex++) {
    const sourceMidpoint = (sourceHigh + sourceLow) / 2;
    const native = chartIndex
      ? nativeRows
      : { 0: [0, sourceMidpoint, sourceHigh, sourceLow, sourceMidpoint] };
    const indices = Object.keys(native).map(Number).sort((a, b) => a - b);
    const bars = {
      firstIndex: () => indices[0] ?? null,
      lastIndex: () => indices.at(-1) ?? null,
      contains: (index) => !!native[index],
      valueAt: (index) => native[index] ?? null,
    };
    const timeScale = {
      coordinateToIndex: () => 0,
      coordinateToFloatIndex: (x) => (x - origin) / spacing,
      indexToCoordinate: (index) => origin + index * spacing,
      barSpacing: () => spacing,
      width: () => width,
      points: () => ({
        valueAt: (index) =>
          index >= 0 && index < rowCount ? index : null,
        range: () => ({
          value: () => ({ firstIndex: 0, lastIndex: rowCount - 1 }),
        }),
        roughTime: (index) => index,
      }),
    };
    const model = {
      lightUpdate() {},
      properties: () => ({
        childs: () => ({
          scalesProperties: {
            childs: () => ({ fontSize: { value: () => 12 } }),
          },
        }),
      }),
      timeScale: () => timeScale,
      mainSeries: () => ({
        bars: () => bars,
        syncModel: () => ({
          isValid: () => true,
          projectTime: (time) => time,
          mwRangeSlot: () => undefined,
        }),
        priceScale: () => ({
          isEmpty: () => false,
          priceToCoordinate: project,
        }),
        firstValue: () => 1,
      }),
    };
    const canvas = {
      isConnected: true,
      getBoundingClientRect: () => ({
        left: chartIndex * 300,
        top: 0,
        right: chartIndex * 300 + width,
        bottom: height,
        width,
        height,
      }),
    };
    const pane = {
      containsMainSeries: () => true,
      canvasElement: () => canvas,
      state: () => ({ model: () => model }),
      width: () => width,
      height: () => height,
      getElement: () => ({ querySelectorAll: () => [] }),
    };
    if (legend && chartIndex === 1) {
      pane._legendWidget = {
        getElement: () => ({
          getBoundingClientRect: () => ({
            left: 300 + legend.left,
            right: 300 + legend.right,
            top: legend.top,
            bottom: legend.bottom,
            width: legend.right - legend.left,
            height: legend.bottom - legend.top,
          }),
        }),
      };
    }
    const chart = {
      symbol: () => "MWP:TEST",
      resolution: () => (chartIndex ? "1" : "5"),
      chartType: () => 1,
      dataReady: () => true,
      priceFormatter: () => ({ format: (price) => price.toFixed(8) }),
      _getTimeConverter: () => ({
        convertInternalTimeToPublicTime: (time) => time,
      }),
      _convertIndexToPublicTime: (index) => index,
      _chartWidget: {
        model: () => ({ model: () => model }),
        paneWidgets: () => [pane],
        ownerDocument: () => doc,
      },
      pane,
    };
    for (const name of [
      "onSymbolChanged",
      "onIntervalChanged",
      "onVisibleRangeChanged",
      "onDataLoaded",
      "onChartTypeChanged",
      "crossHairMoved",
    ]) {
      const subscription = event();
      chart[name] = () => subscription;
    }
    charts.push(chart);
  }
  const sync = { value: () => true, subscribe() {}, unsubscribe() {} };
  const widget = {
    chartsCount: () => charts.length,
    chart: (index) => charts[index],
    crosshairSync: () => sync,
    getTheme: () => "Light",
  };
  const mapping = vm.runInContext("chartBarRangeMapping", context)({
    widget,
    initial: {
      version: 2,
      enabled: true,
      style: "rectangle",
      priceLabels: true,
    },
    frame: (fn) => {
      const id = ++frameId;
      queue.set(id, fn);
      return id;
    },
    cancelFrame: (id) => queue.delete(id),
  });
  mapping.refreshCharts();
  mapping.observeBars({
    symbol: "MWP:TEST",
    resolution: "5",
    bars: [
      {
        chart_time: 0,
        start: sourceStart,
        end: sourceEnd,
        high: sourceHigh,
        low: sourceLow,
      },
    ],
  });
  mapping.observeBars({
    symbol: "MWP:TEST",
    resolution: "1",
    bars: targetRows,
  });
  const flush = () => {
    const callbacks = [...queue.values()];
    queue.clear();
    callbacks.forEach((fn) => fn());
  };
  flush();
  listeners.get("pointermove")({
    pointerType: "mouse",
    clientX: 40,
    clientY: 100,
    target: { tagName: "CANVAS", closest: () => false },
  });
  flush();
  const paint = { fills: [], texts: [], leaders: [] };
  let currentPath = [];
  const canvasContext = {
    save: () => saved++,
    restore: () => restored++,
    scale() {},
    // Deterministic text metrics; real font/DPR raster geometry is browser-tested.
    measureText: () => ({ width: 40 }),
    fillRect: (...args) => paint.fills.push(args),
    strokeRect() {},
    fillText: (...args) => paint.texts.push(args),
    beginPath: () => (currentPath = []),
    moveTo: (...args) => currentPath.push(args),
    lineTo: (...args) => currentPath.push(args),
    stroke: () => paint.leaders.push(currentPath),
  };
  const info = {
    bitmapSize: { width, height },
    mediaSize: { width, height },
  };
  const draw = () => mapping.draw(charts[1].pane, canvasContext, info);
  draw();
  return {
    mapping,
    draw,
    canvasContext,
    paint,
    labels: () => JSON.parse(JSON.stringify(mapping.labels(charts[1]))),
    counts: () => ({ saved, restored }),
  };
}

function check(name, run, options) {
  const f = fixture(options);
  try {
    run(f);
    cases.push({ name });
  } finally {
    f.mapping.dispose();
  }
}

const label = (f, kind) => f.labels().find((item) => item.kind === kind);
const noTagPaint = (f) => {
  assert.equal(f.paint.texts.length, 0);
  assert.equal(f.paint.leaders.length, 0);
};
// Check actual intersection independently of the module's padded collision test.
const intersects = (box, obstacle) =>
  box.x < obstacle.right &&
  box.x + box.width > obstacle.left &&
  box.y < obstacle.bottom &&
  box.y + box.height > obstacle.top;

check("earliest exact matching visible extrema", (f) => {
  assert.deepEqual(
    f.labels().map((item) => [item.kind, item.visible, item.barTime]),
    [["high", true, 0], ["low", true, 1000]],
  );
  assert.deepEqual(f.paint.texts.map(([text]) => text), [
    "高 100.00000000",
    "低 0.00000000",
  ]);
  assert.equal(f.paint.leaders.length, 2);
});

check("hide and redraw cannot resurrect labels", (f) => {
  const paintsBefore = f.paint.fills.length;
  f.mapping.hide();
  assert.deepEqual(f.labels(), []);
  assert.equal(f.mapping.diagnostics().labelPanes, 0);
  f.draw();
  assert.deepEqual(f.labels(), []);
  assert.equal(f.paint.fills.length, paintsBefore);
});

check("unmatched extrema hide", (f) => {
  assert.ok(f.labels().length === 2);
  assert.ok(f.labels().every((item) =>
    !item.visible && item.reason === "unmatched-extreme"));
  noTagPaint(f);
}, {
  targetRows: [{ chart_time: 0, start: 0, end: 1000, high: 90, low: 10 }],
  rowCount: 1,
});

check("metadata without native candles cannot anchor", (f) => {
  assert.ok(f.labels().length === 2);
  assert.ok(f.labels().every((item) =>
    !item.visible && item.reason === "unmatched-extreme"));
  noTagPaint(f);
}, { nativeRows: {} });

check("mismatched native candles cannot anchor", (f) => {
  assert.ok(f.labels().every((item) =>
    !item.visible && item.reason === "unmatched-extreme"));
  noTagPaint(f);
}, {
  nativeRows: {
    0: [0, 30, 70, 20, 30],
    1: [1, 40, 80, 10, 40],
    2: [2, 50, 70, 20, 50],
    3: [3, 50, 80, 20, 50],
  },
});

check("offscreen earliest bar excluded", (f) => {
  assert.equal(label(f, "high").barTime, 2000);
  assert.equal(label(f, "high").visible, true);
}, { origin: -30 });

check("inverted scale exterior sides", (f) => {
  const high = label(f, "high"), low = label(f, "low");
  assert.equal(high.visible, true);
  assert.equal(low.visible, true);
  assert.ok(high.box.y > high.boundary);
  assert.ok(low.box.y + low.box.height < low.boundary);
}, { project: (price) => price + 50 });

check("vertical viewport disjoint hides all", (f) => {
  assert.deepEqual(f.labels(), []);
  assert.deepEqual(f.paint.fills, []);
  noTagPaint(f);
}, { project: (price) => 400 - price });

check("actual legend bounds cause horizontal retreat", (f) => {
  const high=label(f,"high");assert.equal(high.visible,true);
  assert.equal(high.box.y,22);assert.equal(high.box.x,93);assert.equal(high.barX,40);
}, { legend: { left: 0, right: 90, top: 18, bottom: 40 } });

check("retreat left keeps both prices at their original heights", (f) => {
  const high=label(f,"high"),low=label(f,"low");
  assert.ok(high.visible&&low.visible);assert.equal(high.box.y,22);assert.equal(low.box.y,158);
  assert.equal(high.barX,100);assert.equal(high.box.x,59);assert.equal(low.box.x,75);
  const before=f.labels();f.draw();assert.deepEqual(f.labels(),before);
}, {origin:100,spacing:20,sourceEnd:1000,rowCount:2,targetRows:[
  {chart_time:0,start:0,end:1000,high:100,low:0},
  {chart_time:1000,start:1000,end:2000,high:120,low:115}]});

check("retreat right retains an elbow to the actual extreme bar", (f) => {
  const high=label(f,"high"),low=label(f,"low");
  assert.ok(high.visible&&low.visible);assert.equal(high.box.y,22);assert.equal(low.box.y,158);
  assert.equal(high.barX,120);assert.equal(high.box.x,111);assert.equal(high.barTime,1000);
  assert.equal(f.paint.leaders[0][0][0],120);assert.equal(f.paint.leaders[0].at(-1)[0],high.attachX);
}, {origin:100,spacing:20,sourceStart:1000,sourceEnd:2000,rowCount:2,targetRows:[
  {chart_time:0,start:0,end:1000,high:120,low:115},
  {chart_time:1000,start:1000,end:2000,high:100,low:0}]});

check("inverted scale retreat never changes label height", (f) => {
  const high=label(f,"high"),low=label(f,"low");
  assert.ok(high.visible&&low.visible);assert.equal(high.box.y,158);assert.equal(low.box.y,22);
  assert.ok(high.box.x<75);assert.equal(high.barX,100);
}, {origin:100,spacing:20,sourceEnd:1000,rowCount:2,project:price=>50+price,height:230,targetRows:[
  {chart_time:0,start:0,end:1000,high:100,low:0},
  {chart_time:1000,start:1000,end:2000,high:120,low:115}]});

check("full-width obstruction hides without vertical fallback", (f) => {
  assert.equal(label(f,"high").visible,false);assert.equal(label(f,"high").reason,"occupied");
}, {legend:{left:0,right:200,top:18,bottom:40}});

check("dense adjacent candle occupying only leader hides tag", (f) => {
  const high = label(f, "high");
  // The adjacent candle is outside [0,1000), so its higher wick may occupy
  // the short leader even though neither matching candle nor text box does.
  const neighbour = { left: 99.5, right: 101.5, top: 45, bottom: 130 };
  assert.equal(intersects(high.box, neighbour), false);
  assert.equal(high.visible, false);
  assert.equal(high.reason, "occupied");
  assert.ok(!f.paint.texts.some(([text]) => text.startsWith("高 ")));
}, {
  rowCount: 2,
  spacing: 0.5,
  origin: 100,
  sourceEnd: 1000,
  targetRows: [
    { chart_time: 0, start: 0, end: 1000, high: 100, low: 0 },
    { chart_time: 1000, start: 1000, end: 2000, high: 105, low: 20 },
  ],
});

check("legend occupying only leader hides tag", (f) => {
  const high = label(f, "high");
  const obstacle = { left: 98, right: 102, top: 45, bottom: 47 };
  assert.equal(intersects(high.box, obstacle), false);
  assert.equal(high.visible, false);
  assert.equal(high.reason, "occupied");
  assert.ok(!f.paint.texts.some(([text]) => text.startsWith("高 ")));
}, { origin: 100, legend: { left: 98, right: 102, top: 45, bottom: 47 } });

check("zero-width half-open time intersection excluded", (f) => {
  // The last delivered target ends exactly at sourceStart.
  assert.deepEqual(f.labels(), []);
  assert.deepEqual(f.paint.fills, []);
  noTagPaint(f);
}, { sourceStart: 4000, sourceEnd: 5000 });

check("canvas restoration on thrown rendering", (f) => {
  f.canvasContext.measureText = () => { throw new Error("probe canvas exception"); };
  assert.throws(f.draw, /probe canvas exception/);
  assert.equal(f.counts().saved, f.counts().restored);
});

check("configure and dispose clean label state", (f) => {
  f.mapping.configure({ priceLabels: false });
  assert.deepEqual(f.labels(), []);
  assert.equal(f.mapping.diagnostics().labelPanes, 0);
  f.draw();
  assert.deepEqual(f.labels(), []);
  f.mapping.dispose();
  assert.equal(f.mapping.diagnostics().labelPanes, 0);
});

check("one-tick earlier high cannot replace exact high", (f) => {
  assert.equal(label(f, "high").barTime, 1000);
  assert.equal(label(f, "high").visible, true);
  assert.equal(label(f, "high").text, "高 100.00000000");
}, {
  rowCount: 2,
  sourceEnd: 2000,
  targetRows: [
    { chart_time: 0, start: 0, end: 1000, high: 99.99999999, low: 20 },
    { chart_time: 1000, start: 1000, end: 2000, high: 100, low: 0 },
  ],
});

check("nearby tick without exact high hides", (f) => {
  assert.equal(label(f, "high").visible, false);
  assert.equal(label(f, "high").reason, "unmatched-extreme");
  noTagPaint(f);
}, {
  rowCount: 1,
  sourceEnd: 1000,
  targetRows: [{ chart_time: 0, start: 0, end: 1000, high: 99.99999999, low: 20 }],
});

check("one-tick earlier low cannot replace exact low", (f) => {
  assert.equal(label(f, "low").barTime, 1000);
  assert.equal(label(f, "low").visible, true);
}, {
  sourceHigh: 150,
  sourceLow: 100,
  rowCount: 2,
  sourceEnd: 2000,
  project: (price) => 250 - price,
  targetRows: [
    { chart_time: 0, start: 0, end: 1000, high: 130, low: 100.00000001 },
    { chart_time: 1000, start: 1000, end: 2000, high: 150, low: 100 },
  ],
});

console.log(JSON.stringify({
  passed: true,
  count: cases.length,
  sourceSHA256: crypto.createHash("sha256").update(source).digest("hex"),
  cases,
}, null, 2));
