const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(
  fs.readFileSync("../advanced-host/indicator-picker.js", "utf8"),
  context,
);
context.widget = {
  getStudiesList: () => [
    "Moving Average",
    "Moving Average Exponential",
    "MACD",
    "守望 Python SMA",
  ],
};
context.catalog = {
  SMA: {
    label: "简单均线",
    pane: "main",
    aliases: ["SMA", "均线"],
    params: { period: 20 },
  },
};
const entries = vm.runInContext("indicatorEntries(widget,catalog)", context);
context.entries = entries;
assert.equal(entries.length, 4);
assert.equal(entries[0].source, "内置");
assert.equal(entries[0].pane, undefined, "do not guess native pane metadata");
assert.equal(entries[3].source, "Python");
assert.equal(
  entries[3].name,
  "守望 Python SMA",
  "persisted native name must remain stable",
);
for (const q of ["均线", "sma", "SMA", "简单", "Moving Average"]) {
  context.query = q;
  assert.ok(
    vm.runInContext("indicatorMatches(entries,query).length", context) > 0,
    q,
  );
}
assert.equal(
  vm.runInContext("indicatorMatches(entries,'missing').length", context),
  0,
);
context.entries = [
  { label: "contains RSI here", name: "a", id: "a", aliases: [] },
  { label: "RSI suffix", name: "b", id: "b", aliases: [] },
  { label: "RSI", name: "c", id: "c", aliases: [] },
];
assert.deepEqual(
  Array.from(
    vm.runInContext("indicatorMatches(entries,'rsi')", context),
    (row) => row.id,
  ),
  ["c", "b", "a"],
);
console.log(
  "Indicator catalog/search: stable identity, source, Chinese/English and match ranking passed",
);
