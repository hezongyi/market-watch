const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the installed, licensed Pine context without copying vendor code
// into the repository. Run from either the repository root or web directory.
const root = path.resolve(__dirname, "../..");
const bundles = path.join(root, "advanced-host/charting_library/bundles");
const marker = "class IS{constructor(e){this.mindepth=0";
const bundlePath = fs.readdirSync(bundles).find((name) =>
  name.startsWith("library.") && name.endsWith(".js") &&
  fs.readFileSync(path.join(bundles, name), "utf8").includes(marker),
);
assert.ok(bundlePath, "installed Pine context is required for this regression");
const bundle = fs.readFileSync(path.join(bundles, bundlePath), "utf8");
const start = bundle.indexOf(marker);
const end = bundle.indexOf("function kS", start);
const depth = Number(bundle.match(/\.max_series_default_size=(\d+)/)?.[1]);
assert.ok(end > start && depth > 2, "recognize installed Pine context and budget");
const errors = [];
const sandbox = vm.createContext({
  console: { error: (message) => errors.push(message) },
  Gy: { Std: {
    max: Math.max, na: Number.isNaN, max_series_default_size: depth,
    error: (message) => { throw new Error(message); },
  } },
  It: { upperbound_int: (values, value, lo, hi) => {
    while (lo < hi) {
      const middle = (lo + hi) >> 1;
      if (value < values[middle]) hi = middle;
      else lo = middle + 1;
    }
    return lo;
  } },
});
vm.runInContext(bundle.slice(start, end) + ";globalThis.NativeContext=AS;", sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "advanced-host/indicators.js"), "utf8"), sandbox);

function replay(lag) {
  errors.length = 0;
  const symbols = Array.from({ length: 2 }, () => ({
    index: -1, time: NaN, value: NaN, valid: 0,
    isBarUpdate: false, isNewBar: false,
  }));
  symbols.forEach((symbol) => { symbol.script = { get_sym: (i) => symbols[i] }; });
  sandbox.PineJS = { Std: {
    max_series_default_size: depth,
    time: (ctx) => ctx.symbol.time,
    volume: (ctx) => ctx.symbol.valid,
    close: (ctx) => ctx.symbol.value,
  } };
  sandbox.catalog = { SMA: {
    pane: "main", params: { period: 20 }, series: [{ key: "value", type: "line" }],
  } };
  const study = vm.runInContext("new (pythonStudies(PineJS,catalog)[0].constructor)()", sandbox);
  const ctx = new sandbox.NativeContext(symbols[0]);
  study.main(ctx);
  const tick = (id, index, live = false, valid = 1, value = 100 + index) => {
    const symbol = symbols[id];
    symbol.isNewBar = index > symbol.index;
    symbol.index = index;
    symbol.time = 1791280000000 + index * 60000;
    symbol.value = value;
    symbol.valid = valid;
    symbol.isBarUpdate = live;
    ctx.prepare(symbol);
    return study.main(ctx)[0];
  };
  const bars = 16;
  for (let i = 0; i < bars; i++) { tick(0, i); tick(1, i); }
  for (let i = 1; i <= lag; i++) {
    assert.ok(Number.isNaN(tick(0, bars - 1 + i, true)),
      "precise alignment must leave the latest primary bar empty until its feed arrives");
  }
  const older = tick(1, bars - 1, true);
  let caught;
  // Secondary bars arrive sequentially: jumping indices is not a valid replay.
  for (let i = 1; i <= lag; i++) caught = tick(1, bars - 1 + i, true);
  assert.equal(caught, 115 + lag, "catch-up restores the correctly timed value");
  assert.ok(Number.isNaN(older), "late old values must not be written at the primary output time");
  assert.ok(Number.isNaN(tick(1, bars - 1 + lag, true, 0)), "invalid samples stay gaps");
  assert.equal(tick(1, bars - 1 + lag, true, 1, 0), 0, "zero remains valid");
  assert.equal(tick(1, bars - 1 + lag, true, 1, -2), -2, "negative remains valid");
  assert.ok(Number.isNaN(tick(0, bars + lag, true)),
    "the second live rollover must leave a gap while the feed remains at the previous time");
  assert.equal(tick(1, bars + lag, true, 1, 42), 42,
    "the second live rollover fills only after the matching feed arrives");
  assert.equal(ctx.symbol, symbols[0], "evaluation restores primary context");
  assert.deepEqual(errors, [], "actual native alignment must not overrun its history");
  assert.ok(ctx._vars.every((variable) => variable._hist.length <= depth),
    "all timestamp and value storage remains bounded after catch-up");
  assert.equal(ctx.maxAdditionalDepth(), 0,
    "alignment storage must not enlarge mandatory history requests");
  return { lag, older: Number.isNaN(older) ? "gap" : older, caught,
    depths: ctx._vars.map((variable) => variable._hist.length) };
}
const cases = [1, 2, 8, depth - 2, depth - 1, depth + 1].map(replay);

function multiPlot() {
  errors.length = 0;
  const symbols = Array.from({ length: 4 }, () => ({
    index: -1, time: NaN, value: NaN, valid: 0,
    isBarUpdate: false, isNewBar: false,
  }));
  symbols.forEach((symbol) => { symbol.script = { get_sym: (i) => symbols[i] }; });
  sandbox.catalog.SMA.series = ["upper", "middle", "lower"].map((key) => ({ key, type: "line" }));
  const study = vm.runInContext("new (pythonStudies(PineJS,catalog)[0].constructor)()", sandbox);
  const ctx = new sandbox.NativeContext(symbols[0]);
  study.main(ctx);
  const tick = (id, index, live = false, valid = 1) => {
    const symbol = symbols[id];
    symbol.isNewBar = index > symbol.index;
    Object.assign(symbol, { index, time: 1791280000000 + index * 60000,
      value: id * 100 + index, valid, isBarUpdate: live });
    ctx.prepare(symbol);
    return Array.from(study.main(ctx));
  };
  // The native historical calculation feeds all secondary data first.
  for (let id = 1; id <= 3; id++) for (let i = 0; i < 32; i++) tick(id, i);
  for (let i = 0; i < 32; i++) assert.deepEqual(tick(0, i), [100 + i, 200 + i, 300 + i]);
  for (let index = 32; index <= 34; index++) {
    assert.ok(tick(0, index, true).every(Number.isNaN), "all lagging plots remain gaps");
    const first = tick(1, index, true);
    assert.equal(first[0], 100 + index);
    assert.ok(first.slice(1).every(Number.isNaN), "one plot must not carry other old values forward");
    const second = tick(2, index, true, index === 33 ? 0 : 1);
    assert.equal(second[0], 100 + index);
    assert.ok(Number.isNaN(second[2]));
    const third = tick(3, index, true);
    assert.equal(third[2], 300 + index);
    if (index === 33) assert.ok(Number.isNaN(third[1]), "a per-plot gap stays independent");
    else assert.equal(third[1], 200 + index);
  }
  assert.deepEqual(errors, []);
  assert.equal(ctx.symbol, symbols[0]);
  assert.ok(ctx._vars.every((variable) => variable._hist.length <= depth));
  return { historicalBars: 32, liveRollovers: 3, plots: 3 };
}
console.log(JSON.stringify({ nativeBudget: depth, cases, multiPlot: multiPlot() }, null, 2));
