const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const events = [];
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
  events,
});
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), context);
(async () => {
  await vm.runInContext(
    `
ready = true;
widget = {chartsCount:()=>2, chart:(i)=>({
  symbol:()=> 'EURUSD', resolution:()=>i ? '60' : '5',
  resetData:()=>events.push('chart:'+i)
})};
subscriptions.set('five', {symbol:'EURUSD',res:'5', reset:()=>events.push('cache:5')});
subscriptions.set('hour', {symbol:'EURUSD',res:'60', reset:()=>events.push('cache:60')});
pendingHistory.set('EURUSD|5',{instrument:'EURUSD',timeframe:'M5'});
request = async()=>({status:'ready'});
query = async()=>({bars:[], history_revision:'one'});
tick();
`,
    context,
  );
  assert.deepEqual(events, ["cache:5", "chart:0"]);
  console.log(
    "Historical reload invalidates matching cache before resetting only matching panes",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
