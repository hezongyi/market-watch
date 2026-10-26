// Exercise the bridge message path while native history rebuilding is deferred.
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
for (const file of ["series.js", "bar-range-mapping.js", "chart-runtime.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../advanced-host", file), "utf8"),
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
  globalThis.changed=false;
  query=async()=>({cache_revision:20,as_of:2000,history_revalidation:{changed},bars:[]});
  providerHistoryWork.set('MWP:EURUSD|5|old-window',{symbol:'MWP:EURUSD',res:'5',window:'old-window',observation:{first:80,last:160,revision:10,observed_at:1000}});

  globalThis.MWNativeNavigation={busy:()=>true};
  subscriptions.set('fixture',{symbol:'MWP:EURUSD',res:'5',window:'old-window',
    providerListener:'listener',historical:true});
`,
  context,
);
(async () => {
  assert.equal(context.mapper.diagnostics().stores.length, 1);
  await handlers[0]({
    source: context.parent,
    origin: "http://localhost",
    data: {
      channel: "mw-chart-v1",
      type: "provider-event",
      event: { listener: "listener", type: "reset", revision:11,as_of:1100 },
    },
  });
  assert.equal(context.mapper.diagnostics().stores.length,1,"unchanged history review must retain metadata");
  vm.runInContext("changed=true",context);
  await handlers[0]({source:context.parent,origin:"http://localhost",data:{
    channel:"mw-chart-v1",type:"provider-event",event:{listener:"listener",type:"reset",revision:21,as_of:2100}
  }});
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
  console.log(
    "Unchanged reset preserves mapping; confirmed revision invalidates metadata and pending tickets during busy navigation",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
