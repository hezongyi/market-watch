const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({ console });
vm.runInContext(
  fs.readFileSync("../advanced-host/series.js", "utf8") +
    "\n" +
    fs.readFileSync("../advanced-host/price-format.js", "utf8") +
    "\n" +
    fs.readFileSync("../advanced-host/chart-tab.js", "utf8") +
    "\nthis.createTab=chartTab",
  context,
);
const handlers = new Map(),
  subscriptions = [],
  messages = [];
function pane(symbol) {
  const changed = new Set();
  return {
    symbol: () => symbol,
    set(value) {
      symbol = value;
      for (const fn of changed) fn();
    },
    onSymbolChanged: () => ({
      subscribe: (_, fn) => changed.add(fn),
      unsubscribe: (_, fn) => changed.delete(fn),
    }),
    symbolExt: () => ({ pricescale: 100000 }),
    priceFormatter: () => ({ format: (p) => p.toFixed(5) + "%" }),
    listeners: changed,
  };
}
const a = pane("MWP:EURUSD"),
  b = pane("MWP:XAUUSD");
let active = a,
  epoch = 1,
  workspace = { id: "a" };
const widget = {
  chartsCount: () => 2,
  chart: (i) => [a, b][i],
  activeChart: () => active,
  subscribe: (name, fn) => handlers.set(name, fn),
  unsubscribe: (name) => handlers.delete(name),
};
const tab = context.createTab({
  widget,
  feed: {
    unsubscribeQuotes() {},
    subscribeQuotes: (_, symbols, callback) =>
      subscriptions.push({ symbols, callback }),
  },
  send: (m) => messages.push(m),
  workspace: () => workspace,
  epoch: () => epoch,
  metadata: () => null,
});
const first = subscriptions.at(-1).callback;
first([{ n: "MWP:EURUSD", v: { lp: 1.12, chp: -1 } }]);
assert.equal(messages.at(-1).formatted, "1.12000");
assert.ok(
  !messages.at(-1).formatted.includes("%"),
  "percentage chart scale cannot format raw tab prices",
);
const unchanged = messages.length;
b.set("MWP:BTCUSDT");
assert.equal(
  messages.length,
  unchanged,
  "inactive pane edits must not reset title or subscription",
);
b.set("MWP:XAUUSD");
active = b;
handlers.get("activeChartChanged")();
const count = messages.length;
first([{ n: "MWP:EURUSD", v: { lp: 9 } }]);
assert.equal(messages.length, count, "late old pane result must be fenced");
subscriptions
  .at(-1)
  .callback([{ n: "MWP:XAUUSD", v: { lp: 2600, delay_seconds: 10 } }]);
assert.equal(messages.at(-1).delayed, true);
const previous = subscriptions.at(-1).callback;
epoch++;
workspace = { id: "b" };
previous([{ n: "MWP:XAUUSD", v: { lp: 3 } }]);
assert.equal(messages.at(-1).price, 2600);
tab.refresh();
const fresh = subscriptions.at(-1).callback;
b.set("MWH:00000000-0000-0000-0000-000000000001");
assert.equal(messages.at(-1).historical, true);
fresh([{ n: "MWP:XAUUSD", v: { lp: 7 } }]);
assert.equal(messages.at(-1).price, undefined);
tab.dispose();
const disposedCount = messages.length;
subscriptions.at(-1).callback([{ n: b.symbol(), v: { lp: 2 } }]);
assert.equal(messages.length, disposedCount);
assert.equal(handlers.size, 0);
assert.equal(a.listeners.size, 0);
console.log(
  "active chart title pane, ticker, workspace and disposal fences passed",
);
