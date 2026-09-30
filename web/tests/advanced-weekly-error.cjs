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
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), context);
vm.runInContext(
  `historyQuery=async()=>({status:'error',bars:[],error:'provider unavailable',failed_task_ids:[]});`,
  context,
);
(async () => {
  const result = await vm.runInContext(
    `new Promise((resolve,reject)=>feed.getBars({ticker:'EURUSD'},'1W',{to:1800000000,countBack:13},(bars,meta)=>resolve({bars,meta}),reject))`,
    context,
  );
  assert.equal(result.bars.length, 0);
  assert.equal(result.meta.noData, true);
  assert.ok(
    sent.some(
      (m) => m.type === "status" && m.text.includes("周线历史拉取失败"),
    ),
  );
  assert.ok(!sent.some(m => m.text?.includes("已加入后台队列")),
    "failed work must not be reported as queued");
  await vm.runInContext(`(async()=>{
    const recoveryEvents = globalThis.recoveryEvents = [];
    let retry;
    ready = true;
    widget = {
      chartsCount:()=>1,
      chart:()=>({symbol:()=> 'EURUSD',resolution:()=> '1W',
        resetData:()=>recoveryEvents.push('reload')}),
      showConfirmDialog: options => { retry = options.callback; }
    };
    subscriptions.set('weekly', {symbol:'EURUSD',res:'1W',
      reset:()=>recoveryEvents.push('cache-reset')});
    rememberHistoryFailure({instrument:'EURUSD',timeframe:'W1'},
      {failed_task_ids:['failed-week']});
    offerHistoryRetry();
    request=async(q)=>{ if(q.op==='retry') recoveryEvents.push('retry'); return {}; };
    await retry(true);
    historyQuery=async()=>({status:'ready',bars:[]});
    query=async()=>({bars:[]});
    await tick();
  })()`, context);
  assert.deepEqual(Array.from(vm.runInContext('recoveryEvents', context)),
    ['retry', 'cache-reset', 'reload']);
  console.log("Weekly failure, explicit retry and completion cache refresh passed");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
