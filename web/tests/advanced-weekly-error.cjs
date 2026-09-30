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
      (m) => m.type === "status" && m.text.includes("周线暂时没有可用数据"),
    ),
  );
  console.log("Weekly background error completes native empty boundary");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
