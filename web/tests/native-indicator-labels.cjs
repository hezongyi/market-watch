const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const catalog = JSON.parse(
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "import json; from alerts.chart_indicators import public_catalog; print(json.dumps(public_catalog()))",
    ],
    { env: { ...process.env, PYTHONPATH: "backend" } },
  ),
);
const source = fs.readFileSync(
  process.env.NATIVE_INDICATOR_SOURCE ||
    "advanced-host/native-indicator-dialog.js",
  "utf8",
);
const added = source.slice(
  source.indexOf("  function Added()"),
  source.indexOf("  function Detail()"),
);
const inputs = [
  { id: "in_0", value: 12 },
  { id: "in_1", value: 26 },
  { id: "in_2", value: 9 },
];
const definitions = [
  { id: "in_0", localizedName: "快线周期" },
  { id: "in_1", localizedName: "慢线周期" },
  { id: "in_2", localizedName: "信号周期" },
];
const chart = {
  getAllStudies: () => [
    { id: "native", name: "MACD" },
    { id: "python", name: "守望 Python MACD" },
  ],
  getStudyById: (id) => ({
    getInputValues: () =>
      id === "native"
        ? inputs
        : [
            { id: "fast", value: 17 },
            { id: "slow", value: 31 },
            { id: "signal", value: 8 },
          ],
    isVisible: () => true,
  }),
};
const R = {
  useContext: () => ({}),
  useState: () => [null, () => {}],
  createElement: (type, props, ...children) => ({ type, props, children }),
};
const context = vm.createContext({
  R,
  Context: {},
  widget: { activeChart: () => chart, getStudyInputs: () => definitions },
  state: {
    query: "",
    entries: [
      { name: "MACD", source: "内置" },
      { name: "守望 Python MACD", source: "Python", meta: catalog.MACD },
    ],
  },
  indicatorMatches: (items) => items,
});
vm.runInContext(added, context);
const rendered = JSON.stringify(vm.runInContext("Added()", context));
for (const text of [
  "快线周期 12",
  "慢线周期 26",
  "信号周期 9",
  "快线周期 17",
  "慢线周期 31",
  "信号周期 8",
])
  assert(rendered.includes(text), text);
assert(!rendered.includes("in_0="));
assert.deepEqual(
  inputs.map((input) => input.value),
  [12, 26, 9],
);
console.log(
  "Native localized metadata and Python catalogue labels retain actual input values",
);

// Exercise the real bridge's object-entry snapshot without a supplier-dependent
// calculation origin. The deployed native test separately checks actual inputs.
const bridgeContext = vm.createContext({
  crypto: require("node:crypto").webcrypto,
});
vm.runInContext(
  fs.readFileSync("advanced-host/series.js", "utf8"),
  bridgeContext,
);
vm.runInContext(
  fs.readFileSync("advanced-host/chart-alerts.js", "utf8"),
  bridgeContext,
);
const values = [
  { id: "fast", value: 19 },
  { id: "slow", value: 35 },
  { id: "signal", value: 11 },
];
const snapshotChart = {
  symbol: () => "XAUUSD",
  resolution: () => "240",
  chartType: () => 1,
  getAllStudies: () => [{ id: "python", name: "守望 Python MACD" }],
  getStudyById: () => ({ getInputValues: () => values }),
};
const messages = [];
const bridge = bridgeContext.chartAlertBridge({
  getWidget: () => ({
    activeChart: () => snapshotChart,
    chartsCount: () => 1,
    chart: () => snapshotChart,
  }),
  getWorkspace: () => ({ id: "fixture" }),
  getEpoch: () => 1,
  isLoading: () => false,
  readonly: false,
  metadata: () => ({ source: "dukascopy", symbol: "XAUUSD", basis: "bid" }),
  frames: { 240: "H4" },
  calculationOrigin: () => 1000,
  rpc: () => {
    throw Error("No RPC expected");
  },
  send: (m) => messages.push(m),
  fail: (error) => {
    throw error;
  },
});
bridge
  .create({ object: { type: "study", id: "python" } })
  .then(() => {
    const snapshot = messages.find(
      (m) => m.type === "chart-alert-context",
    ).context;
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.indicator.params)), {
      fast: 19,
      slow: 35,
      signal: 11,
    });
    assert.equal(snapshot.calculation_origin, 1000);
    assert.equal(snapshot.indicator.output, "macd");
    values[0].value = 23;
    assert.equal(
      snapshot.indicator.params.fast,
      19,
      "Chart edits cannot mutate an existing snapshot",
    );
    console.log(
      "Real Python object-entry bridge captures changed values and keeps independent snapshot",
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
