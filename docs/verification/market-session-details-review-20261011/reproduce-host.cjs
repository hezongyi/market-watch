// Exercise the actual pure formatter/cache functions; this is not native UI acceptance.
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("advanced-host/bridge.js", "utf8");
const functions = source.slice(source.indexOf("function quoteTimeText"), source.indexOf("function bindTimezoneEvents"));
let timezone = "UTC";
const context = {
  Intl, Date, Number,
  widget: {activeChart: () => ({getTimezoneApi: () => ({getTimezone: () => ({id: timezone})})})},
  presentationFor: () => ({source: "dukascopy", timezone: "Etc/UTC"}),
  chartQuotePresentation: row => row,
  quoteSubscriptions: new Map(), quoteSnapshotRows: new Map(),
};
vm.createContext(context);
vm.runInContext(functions, context);
const raw = {s: "ok", n: "DUKA:XAUUSD", v: {
  lp: 4000, description: "XAUUSD · 休市", quote_time: null,
  data_start: Date.parse("2026-10-09T20:59:00Z"), time_type: "source_m1",
}};
const first = context.presentQuote(raw);
timezone = "Asia/Shanghai";
const results = {formatted_cache_after_timezone_change: context.presentQuote(first).v.description};
context.quoteSubscriptions.set("watchlist", {
  symbols: ["A", "B"], lastRows: [{s: "ok", n: "B", v: raw.v}],
  cb: rows => {results.refreshed_tickers = rows.map(row => row.n);},
});
context.quoteSnapshotRows.set("A", {s: "ok", n: "A", v: raw.v});
context.quoteSnapshotRows.set("B", {s: "ok", n: "B", v: raw.v});
context.refreshQuotePresentation();
results.missing_time = context.presentQuote({s: "ok", n: "EMPTY", v: {
  description: "报价准备中", market_session: "unknown", quote_time: null, data_start: null,
}}).v.description;
console.log(JSON.stringify(results, null, 2));
