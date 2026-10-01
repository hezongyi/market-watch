const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const ctx = vm.createContext({
  crypto: require("node:crypto").webcrypto,
  URL,
  URLSearchParams,
  Intl,
  Date,
  Map,
  Set,
  Math,
  Number,
  JSON,
  Promise,
  setTimeout,
  clearTimeout,
  location: { search: "?parent=http://localhost:5188" },
  parent: { postMessage() {} },
  addEventListener() {},
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), ctx);
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), ctx);
function check(start, end, res, symbol, expected) {
  const actual = vm.runInContext(
    `stamp({start:${Date.parse(start)},end:${Date.parse(end)}},'${res}','${symbol}')`,
    ctx,
  );
  assert.equal(new Date(actual).toISOString(), expected);
}
check(
  "2026-03-08T21:00Z",
  "2026-03-09T21:00Z",
  "1D",
  "XAUUSD",
  "2026-03-09T00:00:00.000Z",
);
check(
  "2026-03-05T22:00Z",
  "2026-03-06T22:00Z",
  "1D",
  "EURUSD",
  "2026-03-06T00:00:00.000Z",
);
check(
  "2026-03-08T21:00Z",
  "2026-03-15T21:00Z",
  "1W",
  "XAUUSD",
  "2026-03-09T00:00:00.000Z",
);
check(
  "2026-03-01T22:00Z",
  "2026-03-08T21:00Z",
  "1W",
  "EURUSD",
  "2026-03-02T00:00:00.000Z",
);
check(
  "2026-02-28T22:00Z",
  "2026-03-31T21:00Z",
  "1M",
  "XAUUSD",
  "2026-03-01T00:00:00.000Z",
);
check(
  "2026-03-08T00:00Z",
  "2026-03-09T00:00Z",
  "1D",
  "BTCUSDT",
  "2026-03-08T00:00:00.000Z",
);
check(
  "2026-03-09T00:00Z",
  "2026-03-16T00:00Z",
  "1W",
  "BTCUSDT",
  "2026-03-09T00:00:00.000Z",
);
check(
  "2026-03-01T00:00Z",
  "2026-04-01T00:00Z",
  "1M",
  "BTCUSDT",
  "2026-03-01T00:00:00.000Z",
);
check(
  "2026-03-08T21:00Z",
  "2026-03-09T01:00Z",
  "240",
  "XAUUSD",
  "2026-03-08T21:00:00.000Z",
);
// Autumn NY17 boundary and a holiday-shortened trading session keep trading-date labels.
check("2026-11-01T22:00Z", "2026-11-02T22:00Z", "1D", "XAUUSD", "2026-11-02T00:00:00.000Z");
check("2026-10-25T21:00Z", "2026-11-01T22:00Z", "1W", "EURUSD", "2026-10-26T00:00:00.000Z");
check("2026-11-26T22:00Z", "2026-11-27T18:45Z", "1D", "XAUUSD", "2026-11-27T00:00:00.000Z");
check("2026-11-01T22:00Z", "2026-11-02T02:00Z", "240", "XAUUSD", "2026-11-01T22:00:00.000Z");
console.log("13 calendar label cases passed; intraday timestamp unchanged");
