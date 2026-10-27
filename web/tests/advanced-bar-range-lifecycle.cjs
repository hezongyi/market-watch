// Unified runtime updates invalidate mapping while native rebuilding is deferred.
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const handlers = [];
const context = vm.createContext({
  URL,
  URLSearchParams,
  Map,
  Set,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage() {} },
  crypto: { randomUUID: () => "listener" },
  addEventListener(name, fn) {
    if (name === "message") handlers.push(fn);
  },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  setTimeout,
  clearTimeout,
});
for (const file of ["series.js", "composite-display-batches.js", "bar-range-mapping.js", "chart-runtime.js"]) {
  vm.runInContext(
    require("./fixtures/direct-runtime.cjs").read(path.join(__dirname, "../../advanced-host", file), "utf8"),
    context,
  );
}
vm.runInContext(
  `
  barRangeMapping=chartBarRangeMapping({});
  globalThis.mapper=barRangeMapping;
  globalThis.oldTicket=mapper.capture('MWP:EURUSD','5','old-window');
  mapper.observeBars({symbol:'MWP:EURUSD',resolution:'5',window:'old-window',ticket:oldTicket,
    bars:[{chart_time:100,start:80,end:160,high:2,low:1}]});
  ready=true;
  const chart={symbol:()=> 'MWP:EURUSD',resolution:()=> '5',getAllStudies:()=>[]};
  widget={chartsCount:()=>1,chart:()=>chart};
  globalThis.MWNativeNavigation={busy:()=>true};
  subscriptions.set('fixture',{symbol:'MWP:EURUSD',res:'5',window:'old-window',
    marketListener:'listener',marketGeneration:1,marketSequence:0,historical:true});
`,
  context,
);
(async () => {
  assert.equal(context.mapper.diagnostics().stores.length, 1);
  // A status event means the backend verified accepted history is unchanged.
  await handlers[0]({data:{type:'market-event',event:{listener:'listener',generation:1,
    sequence:1,type:'status',status:'history_current'}}});
  assert.equal(context.mapper.diagnostics().stores.length,1,'unchanged history retains metadata');
  await handlers[0]({data:{type:'market-event',event:{listener:'listener',generation:1,
    sequence:2,type:'reset',reason:'history_changed'}}});
  assert.equal(
    context.mapper.diagnostics().stores.length,
    0,
    "confirmed revision retained old metadata",
  );
  assert.equal(
    vm.runInContext("subscriptions.get('fixture').needsHistoryReload", context),
    true,
  );
  context.mapper.observeBars({
    symbol: "MWP:EURUSD",
    resolution: "5",
    window: "old-window",
    ticket: context.oldTicket,
    bars: [{ chart_time: 100, start: 80, end: 160, high: 3, low: 0 }],
  });
  assert.equal(
    context.mapper.diagnostics().stores.length,
    0,
    "late accepted callback restored reset data",
  );
  vm.runInContext("clearTimeout(subscriptions.get('fixture').marketRetry)",context);
  console.log(
    "Unchanged history preserves mapping; confirmed revision invalidates metadata and pending tickets during busy navigation",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
