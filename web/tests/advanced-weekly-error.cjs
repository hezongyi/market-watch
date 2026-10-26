const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const sent = [];
const context = vm.createContext({
  URL,
  URLSearchParams,
  Map,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage: (m) => sent.push(m) },
  crypto: { randomUUID: () => "test" },
  addEventListener() {},
  setTimeout,
  clearTimeout,
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/chart-runtime.js", "utf8"), context);
vm.runInContext(
  `request=async args=>{
    if(args.op==='dataset')return {ready:true,start:0,revision:1};
    throw Error('provider unavailable');
  };`,
  context,
);
(async () => {
  await assert.rejects(vm.runInContext(
    `new Promise((resolve,reject)=>feed.getBars({ticker:'EURUSD'},'1W',{to:1800000000,countBack:13},(bars,meta)=>resolve({bars,meta}),reject))`,
    context,
  ),error=>String(error).includes('provider unavailable'));
  assert.ok(
    sent.some(
      (m) => m.type === "error" && m.error.includes("provider unavailable"),
    ),
  );
  assert.ok(!sent.some(m => m.text?.includes("已加入后台队列")),
    "failed work must not be reported as queued");
  await vm.runInContext(`(async()=>{
    const recoveryEvents = globalThis.recoveryEvents = [];
    ready = true;
    refreshChartHistory=async(widget,chart,invalidate,current)=>{
      if(!current())return false;invalidate();chart.resetData();return true;
    };
    widget = {
      chartsCount:()=>1,
      chart:()=>({symbol:()=> 'EURUSD',resolution:()=> '1W',
        getTimeScale:()=>({rightOffset:()=>0,width:()=>960,barSpacing:()=>6}),
        resetData:()=>recoveryEvents.push('reload')}),
    };
    subscriptions.set('weekly', {symbol:'EURUSD',res:'1W',
      reset:()=>recoveryEvents.push('cache-reset')});
    request=async args=>args.op==='dataset' ? {ready:true,start:0,revision:2} :
      {bars:[{start:1700000000000,end:1700604800000,open:1,high:2,low:1,close:2}],has_more:false};
    await refreshManagedHistory('EURUSD');
    const recovered=await new Promise((resolve,reject)=>feed.getBars({ticker:'EURUSD'},'1W',
      {to:1800000000,countBack:13},(bars,meta)=>resolve({bars,meta}),reject));
    if(recovered.bars.length!==1)throw Error('explicit retry must recover real bars');
  })()`, context);
  assert.deepEqual(Array.from(vm.runInContext('recoveryEvents', context)),
    ['cache-reset', 'reload']);
  console.log("Weekly failure stays an error; explicit refresh clears cache and recovers bars");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
