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
  parent: { postMessage: (message) => events.push(message) },
  crypto: { randomUUID: () => "test" },
  addEventListener() {},
  setTimeout(callback, delay) {
    assert.equal(
      delay,
      0,
      "weekly callback must not sleep waiting for backfill",
    );
    return setTimeout(callback, delay);
  },
  clearTimeout,
  events,
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/chart-runtime.js", "utf8"), context);
(async () => {
  const result = await vm.runInContext(
    `
    let resolution='1W', state='pending', reads=0;
    ready=true;
    refreshChartHistory=async(widget,chart,invalidate,current)=>{
      if(!current())return false;invalidate();chart.resetData();return true;
    };
    widget={chartsCount:()=>1,chart:()=>({symbol:()=> 'EURUSD',
      resolution:()=>resolution,getTimeScale:()=>({rightOffset:()=>0,width:()=>960,barSpacing:()=>6}),
      resetData:()=>events.push('reset')}),resetCache:()=>{}};
    rangeGuard={busy:()=>false,captureTerminalCompletion:()=>()=>events.push('terminal')};
    request=async args=>{
      reads++;
      if(args.op==='dataset') return {ready:state==='ready',reason:'preparing',start:0,revision:1};
      return {bars:[{start:1699000000000,end:1699604800000,open:1,high:2,low:1,close:2}],has_more:false};
    };
    new Promise((resolve,reject)=>feed.getBars({ticker:'EURUSD'},'1W',
      {to:1700000000,countBack:13},(bars,meta)=>resolve({bars,meta}),reject));
  `,
    context,
  );
  assert.equal(result.bars.length, 0);
  assert.equal(result.meta.noData, true);
  assert.equal(vm.runInContext("reads", context), 1);
  assert.equal(vm.runInContext("pendingHistory.size", context), 0,
    'viewing a preparing weekly dataset must not schedule history');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.includes("terminal"));
  await vm.runInContext("tick()", context);
  assert.equal(vm.runInContext("pendingHistory.size", context), 0);
  assert.equal(events.filter((event) => event === "reset").length, 0);
  await vm.runInContext("state='ready';tick()", context);
  assert.equal(vm.runInContext("pendingHistory.size", context), 0);
  assert.equal(events.filter((event) => event === "reset").length, 0,
    'background completion must not reset the user viewport');
  await vm.runInContext("refreshManagedHistory('EURUSD')", context);
  assert.equal(events.filter((event) => event === "reset").length, 1);
  await vm.runInContext(
    `
    pendingHistory.set('old',{instrument:'EURUSD',timeframe:'W1'});
    resolution='5';reads=0;tick();
  `,
    context,
  );
  assert.equal(vm.runInContext("reads", context), 0);
  assert.equal(vm.runInContext("pendingHistory.size", context), 0);
  console.log(
    "Weekly preparing callback yields, releases guard, and refreshes only on explicit action",
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
