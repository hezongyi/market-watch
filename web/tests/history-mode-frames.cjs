// Execute the production datafeed boundary with each real frame capability shape.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

async function resolve(source, frames, resolution = "60", kind = "provider") {
  const results = [], changes = [];
  const ticker = kind === "history" ? "MWH:00000000-0000-0000-0000-000000000001" : "MWP:AKSHARE:fixture";
  const ctx = vm.createContext({
    URL, URLSearchParams, Map, Set, Promise, Date, Intl, Error, setTimeout, clearTimeout,
    document: {createElement: () => ({}), head: {append() {}}},
    location: {search: "?parent=http://localhost"}, parent: {postMessage() {}},
    crypto: {randomUUID: () => "test"}, addEventListener() {}, results, changes, ticker, resolution,
    metadata: {source, frames, symbol: "fixture", name: "fixture", basis: "last", calendar: "source_date",
      precision: 4, asset_type: "EQUITY", timezone: "Asia/Shanghai", session: "24x7"},
  });
  for (const name of ["series.js", "price-format.js", "composite-display-batches.js", "chart-runtime.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "advanced-host", name), "utf8"), ctx);
  }
  await vm.runInContext(`(async () => {
    ready = true;
    const chart = {symbol: () => ticker, resolution: () => resolution,
      setResolution: (value) => { changes.push(value); resolution = value; }};
    widget = {chartsCount: () => 1, chart: () => chart, activeChart: () => chart};
    request = async () => metadata;
    await feed.resolveSymbol(ticker, value => results.push(value), error => { throw Error(error); });
  })()`, ctx);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(results.length, 1);
  return {info: JSON.parse(JSON.stringify(results[0])), changes};
}

(async () => {
  let result = await resolve("akshare", ["D1", "W1", "MN"]);
  assert.equal(result.info.has_intraday, false);
  assert.equal(result.info.has_daily, true);
  assert.equal(result.info.has_weekly_and_monthly, true);
  assert.deepEqual(result.info.supported_resolutions, ["1D", "1W", "1M"]);
  assert.equal(result.info.session, "24x7");
  assert.deepEqual(result.changes, ["1D"]);
  result = await resolve("akshare", ["M5"]);
  assert.equal(result.info.has_intraday, true);
  assert.equal(result.info.has_daily, false);
  assert.equal(result.info.has_weekly_and_monthly, false);
  assert.deepEqual(result.info.supported_resolutions, ["5"]);
  assert.deepEqual(result.changes, ["5"]);
  result = await resolve("yahoo", ["M5", "H1", "D1"]);
  assert.deepEqual(result.changes, []);
  result = await resolve("yahoo", ["D1"]);
  assert.deepEqual(result.changes, ["1D"]);
  result = await resolve("fixture", ["W1"], "60", "history");
  assert.equal(result.info.has_daily, false);
  assert.deepEqual(result.info.supported_resolutions, ["1W"]);
  assert.deepEqual(result.changes, ["1W"]);
  console.log("Managed history frame capabilities, source-date visibility and valid fallback passed");
})().catch(error => {console.error(error); process.exitCode = 1;});
