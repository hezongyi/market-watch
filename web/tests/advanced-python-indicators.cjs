const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({
  URL,
  URLSearchParams,
  Map,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage() {} },
  crypto: { randomUUID: () => "test" },
  addEventListener() {},
  setTimeout,
  clearTimeout,
  atob: (s) => Buffer.from(s, "base64").toString("utf8"),
  btoa: (s) => Buffer.from(s).toString("base64"),
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), context);
vm.runInContext(
  fs.readFileSync("../advanced-host/indicators.js", "utf8"),
  context,
);
const ticker =
  "MWPY_" +
  Buffer.from(
    JSON.stringify({
      symbol: "EURUSD",
      spec: { name: "MACD", params: {} },
      key: "histogram",
    }),
  ).toString("base64");
context.ticker = ticker;
context.result = {
  bars: [{ start: 1000 }, { start: 2000 }, { start: 3000 }, { start: 4000 }],
  indicators: [
    {
      series: [
        { key: "macd", values: [{ time: 3000, value: 99 }] },
        {
          key: "histogram",
          values: [
            { time: 3000, value: -2 },
            { time: 1000, value: null },
            { time: 2000, value: 0 },
          ],
        },
      ],
    },
  ],
};
const bars = vm.runInContext('barsOf(result,"1",ticker)', context);
assert.deepEqual(
  Array.from(bars, (b) => b.volume),
  [0, 1, 1, 0],
);
assert.equal(bars[1].close, 0, "real zero must remain valid");
assert.equal(bars[2].close, -2, "select correct series by key and timestamp");
context.catalog = {
  MACD: {
    pane: "sub",
    params: { fast: 12, slow: 26, signal: 9 },
    series: [{ key: "histogram", type: "histogram" }],
  },
};
context.PineJS = {
  Std: {
    max_series_default_size: 10001,
    time: (c) => (c.index === 0 ? 3000 : c.sourceTime),
    volume: (c) => (c.valid ? 1 : 0),
    close: () => 0,
  },
};
const study = vm.runInContext(
  "new (pythonStudies(PineJS,catalog)[0].constructor)()",
  context,
);
const alignment = [];
const ctx = {
  index: 0,
  sourceTime: 2000,
  valid: false,
  select_sym(i) {
    this.index = i;
  },
  new_var(value) {
    return {
      value,
      get: () => value,
      indexOf: () => 0,
      adopt(source, target, mode) {
        alignment.push([source.value, target.value, mode]);
        return value;
      },
    };
  },
};
assert.ok(
  Number.isNaN(study.main(ctx)[0]),
  "warmup must reach native plot as NaN",
);
ctx.valid = true;
assert.ok(Number.isNaN(study.main(ctx)[0]), "a valid older sample cannot fill the latest primary bar");
ctx.sourceTime = 3000;
assert.equal(study.main(ctx)[0], 0, "real zero must reach native plot as zero");
assert.deepEqual(alignment, [
  [3000, 3000, 1],
]);
assert.equal(ctx.index, 0, "restore primary symbol context after evaluation");
console.log(
  "Python indicator adapter: warmup, real zero, negative values, series keys and time alignment passed",
);

// Historical Python feeds must retain the native window and plain backend ID.
context.windowSymbols=[];
context.PineJS.Std.period=()=> '5';
vm.runInContext(`const historical=new (pythonStudies(PineJS,catalog)[0].constructor)();
  historical.init({symbol:{info:{ticker:'MWP:EURUSD'},tickerid:'={"mw-window":"mw-test","symbol":"MWP:EURUSD"}'},
    new_sym:ticker=>windowSymbols.push(ticker)},index=>[12,26,9][index]);`,context);
const extended=JSON.parse(context.windowSymbols[0].slice(1));
assert.equal(extended['mw-window'],'mw-test');
const payload=JSON.parse(Buffer.from(extended.symbol.slice(5),'base64').toString());
assert.equal(payload.symbol,'MWP:EURUSD');
console.log('Python feed retains historical window identity without changing backend symbol');
