const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("advanced-host/bridge.js", "utf8");
let timezone = "UTC";
const context = {
  Intl, Date, Number, compactQuote: null,
  widget: {activeChart: () => ({getTimezoneApi: () => ({getTimezone: () => ({id: timezone})})})},
  chartQuotePresentation: row => row,
  symbolPresentations: new Map(), quoteSnapshotRows: new Map(), quoteResetTokens: new Map(), quoteSubscriptions: new Map(),
  decode: ticker => ({symbol: ticker}),
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("function quoteTimeText"), source.indexOf("function bindTimezoneEvents")), context);
vm.runInContext(source.slice(source.indexOf("function presentationFor"), source.indexOf("const alertSourceMetadata")), context);
context.symbolPresentations.set("A", {timezone: "America/New_York"});
const row = {s: "ok", n: "A", v: {lp: 4000, description: "A · 休市 · 最后行情时间 old UTC",
  description_base: "A", market_session: "closed", session_reason: "周末",
  quote_time: null, data_start: Date.parse("2026-10-09T20:59:00Z"), data_end: Date.parse("2026-10-09T21:00:00Z"), time_type: "source_m1"}};
context.rememberQuoteRows([row]);
const first = context.presentQuote(row);
timezone = "Asia/Shanghai";
const second = context.presentQuote(first);
assert.equal((second.v.description.match(/来源 M1 分钟数据/g) || []).length, 1);
assert.match(second.v.description, /2026-10-10 04:59:00 UTC\+8/);
assert.match(second.v.description, /休市 · 周末/);
assert.equal(second.v.lp, row.v.lp); assert.equal(second.v.data_start, row.v.data_start);
let received;
context.quoteSubscriptions.set("watchlist", {symbols: ["A", "B"], lastRows: [], cb: rows => {received = rows;}});
context.rememberQuoteRows([{...row, n: "B"}]);
// Model the production single-symbol stream update; every cached ticker must reformat.
context.quoteSubscriptions.get("watchlist").lastRows = [{...row, n: "B"}];
context.refreshQuotePresentation();
assert.deepEqual(Array.from(received, row => row.n), ["A", "B"]);
const empty = context.presentQuote({s: "ok", n: "A", v: {description_base: "A", market_session: "unknown", quote_time: null, data_start: null}});
assert.match(empty.v.description, /时段未核实/); assert.match(empty.v.description, /暂无行情更新时间/);
const failed=context.presentQuote({s:"error",n:"A",v:{description_base:"A",market_session:"closed",fetch_status:"fetch_failed",data_start:null}});
assert.equal(failed.s,"ok");assert.equal(failed.v.lp,undefined);
assert.match(failed.v.description,/更新失败，暂无成功行情/);
timezone = "exchange";
assert.match(context.presentQuote(row).v.description, /2026-10-09 16:59:00 America\/New_York \(UTC-4\)/);
timezone = "America/New_York";
const winter = context.presentQuote({...row, v: {...row.v, data_start: Date.parse("2026-12-31T23:00:00Z")}});
assert.match(winter.v.description, /2026-12-31 18:00:00 America\/New_York \(UTC-5\)/);
const prior = context.quoteSnapshotRows.get("A");
context.rememberQuoteRows([{...row, v: {...row.v, lp: 5, read_at: 100}}]);
context.rememberQuoteRows([{...row, v: {...row.v, lp: 1, read_at: 50}}]);
assert.equal(context.quoteSnapshotRows.get("A").v.lp, 5);
assert.equal(prior.v.lp, 4000);
context.workspaceEpoch = 1;
context.initialHistoryGate = null;
context.send = () => {};
context.crypto = {randomUUID: () => "listener"};
context.marketGeneration = 0;
context.marketPollingFallback = true;
context.marketQuery = ticker => ({ticker});
context.setTimeout = setTimeout;
context.seriesPresentationRows = () => [];
let resolveRequest;
context.request = () => new Promise(resolve => {resolveRequest=resolve;});
vm.runInContext(source.slice(source.indexOf("const feed = {"),source.indexOf("  onReady: (cb) =>"))+"};",context);
(async()=>{
  vm.runInContext("feed.getQuotes(['A'], rows => { delivered=rows; }, error => { throw Error(error); });",context);
  await new Promise(resolve=>setImmediate(resolve));
  const streamed={...row,v:{...row.v,lp:99,read_at:200,revision_id:"new"}};
  context.rememberQuoteRows([streamed]);
  // A late HTTP read must not overwrite an accepted stream binding, even if
  // its wall-clock read_at is later. This covers revision/identity replacement.
  resolveRequest([{...row,v:{...row.v,lp:3,read_at:300,revision_id:"old"}}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.delivered[0].v.lp,99);
  assert.equal(context.delivered[0].v.revision_id,"new");
  context.stillCurrent=true;context.called=false;
  vm.runInContext("feed.getQuotes(['A'], () => { called=true; }, error => { throw Error(error); }, () => stillCurrent);",context);
  await new Promise(resolve=>setImmediate(resolve));
  context.stillCurrent=false;resolveRequest([row]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.called,false);
  let rejectRequest;
  context.request=()=>new Promise((resolve,reject)=>{rejectRequest=reject;});
  context.called=false;context.failed=false;
  vm.runInContext("feed.getQuotes(['A'], rows => { called=true; delivered=rows; }, () => { failed=true; });",context);
  await new Promise(resolve=>setImmediate(resolve));rejectRequest(Error('HTTP failed'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.called,true);assert.equal(context.failed,true);
  assert.equal(context.delivered[0].v.lp,99);
  assert.match(context.delivered[0].v.description,/更新失败，保留上次数据/);
  context.called=false;context.failed=false;context.stillCurrent=true;
  vm.runInContext("feed.getQuotes(['A'], () => { called=true; }, () => { failed=true; }, () => stillCurrent);",context);
  await new Promise(resolve=>setImmediate(resolve));context.stillCurrent=false;rejectRequest(Error('cancelled HTTP failed'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.called,false);assert.equal(context.failed,false);
  for(const rejected of [false,true]) {
    context.quoteSnapshotRows.delete('A');context.called=false;context.failed=false;
    context.request=()=>new Promise((resolve,reject)=>{resolveRequest=resolve;rejectRequest=reject;});
    vm.runInContext("feed.getQuotes(['A'], () => { called=true; }, () => { failed=true; });",context);
    await new Promise(resolve=>setImmediate(resolve));
    // Reset must fence the first HTTP request even when both caches are empty.
    context.quoteResetTokens.set('A',{});
    if(rejected)rejectRequest(Error('old generation'));else resolveRequest([row]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(context.called,false);assert.equal(context.failed,false);
    assert.equal(context.quoteSnapshotRows.has('A'),false);
  }
  console.log("Market session presentation regressions passed (including late HTTP/stream binding and cancelled subscription)");
})().catch(error=>{console.error(error);process.exitCode=1;});
