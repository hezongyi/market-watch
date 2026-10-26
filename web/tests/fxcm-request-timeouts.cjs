const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const delays = [];
const context = vm.createContext({
  document: { createElement: () => ({}), head: { append() {} } },
  URL, URLSearchParams, Map, Promise, Date, Intl, Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage() {} },
  crypto: { randomUUID: () => "fxcm-timeout-test" },
  addEventListener() {},
  setTimeout: (_callback, delay) => { delays.push(delay); return delays.length; },
  clearTimeout() {},
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/composite-display-batches.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/chart-runtime.js", "utf8"), context);

function timeoutFor(query, type = "data") {
  delays.length = 0;
  context.testQuery = query;
  context.testType = type;
  vm.runInContext("pending.clear(); requests.length = 0; request(testQuery, testType);", context);
  assert.equal(delays.length, 1, "request should dispatch exactly one deadline");
  return delays[0];
}

assert.equal(timeoutFor({ series_kind: "provider", instrument: "MWP:FXCM:EURUSD" }), 70000);
assert.equal(timeoutFor({ series_kind: "provider", instrument: "FXCM:XAUUSD" }), 70000);
assert.equal(timeoutFor({ path: "/market-data/history-catalog/refresh", body: { source: "fxcm" } }, "data-center-api"), 70000);
assert.equal(timeoutFor({ path: "/market-data/history-catalog/refresh", body: { source: "oanda" } }, "data-center-api"), 30000);
assert.equal(timeoutFor({ path: "/market-data/history-catalog", body: { source: "fxcm" } }, "data-center-api"), 30000);
assert.equal(timeoutFor({ series_kind: "provider", instrument: "OANDA:EURUSD" }), 30000);
assert.equal(timeoutFor({ series_kind: "provider", instrument: "FXCM:EURUSD", native_history: true }), 610000);
assert.equal(timeoutFor({ series_kind: "provider", instrument: "FXCM:EURUSD", native_history: true, native_reserve: true }), 70000);
console.log("FXCM provider and embedded refresh deadlines cover cold login; other deadlines remain source-specific");
