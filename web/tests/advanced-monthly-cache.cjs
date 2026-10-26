const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
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
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/chart-runtime.js", "utf8"), context);
vm.runInContext(
  `
let localBars = [], calls = 0, emptyCompletions = 0;
rangeGuard = { captureTerminalCompletion(matches) {
  if (!matches({symbol:()=> 'BTCUSDT',resolution:()=> '1M'}))
    throw Error('matching monthly pane was missed');
  if (matches({symbol:()=> 'EURUSD',resolution:()=> '1M'}))
    throw Error('unrelated pane matched');
  return () => emptyCompletions++;
}};
request = async (args) => {
  if(args.op==='dataset') return {ready:localBars.length>0,start:0,revision:1,reason:'preparing'};
  calls++;
  const bars = localBars.filter(b=>b.start < args.before).slice(-args.limit);
  return {bars,has_more:localBars.some(b=>b.start<(bars[0]?.start || 0))};
};
function monthly(count) {
  return new Promise((resolve,reject)=>feed.getBars({ticker:'BTCUSDT'},'1M',
    {to:Date.UTC(2200,9,1)/1000,countBack:count,firstDataRequest:true},
    (bars,meta)=>resolve({bars,meta}),reject));
}
function seed(count) {
  localBars=Array.from({length:count},(_,i)=>({start:Date.UTC(1970,i,1),
    end:Date.UTC(1970,i+1,1),open:1,high:2,low:1,close:2}));
  calls=0;
}
`,
  context,
);
(async () => {
  let result = await vm.runInContext("seed(0);monthly(90)", context);
  assert.equal(result.bars.length, 0);
  assert.equal(result.meta.noData, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(vm.runInContext("emptyCompletions", context), 1);
  result = await vm.runInContext("seed(3);monthly(90)", context);
  assert.equal(result.bars.length, 3);
  assert.equal(result.meta.noData, true);
  assert.equal(vm.runInContext("calls", context), 1);
  result = await vm.runInContext("seed(2101);monthly(2100)", context);
  assert.equal(result.bars.length, 2100);
  assert.equal(result.meta.noData, false);
  assert.equal(vm.runInContext("calls", context), 2);
  assert.equal(new Set(result.bars.map((b) => b.time)).size, 2100);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(vm.runInContext("emptyCompletions", context), 1,
    "nonempty results must wait for native dataReady");
  console.log(
    "Monthly local-only history: empty, partial and multi-page cached data passed",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
