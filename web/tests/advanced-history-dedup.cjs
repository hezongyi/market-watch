const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const pending = [];
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
  testRequests: pending,
});
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), context);
vm.runInContext(
  "request=(q)=>new Promise((resolve,reject)=>testRequests.push({q,resolve,reject}))",
  context,
);
(async () => {
  const a = vm.runInContext(
    'historyQuery({instrument:"EURUSD",timeframe:"M5",before:100,limit:300})',
    context,
  );
  const b = vm.runInContext(
    'historyQuery({limit:300,before:100,timeframe:"M5",instrument:"EURUSD"})',
    context,
  );
  assert.equal(a, b);
  assert.equal(pending.length, 1);
  const c = vm.runInContext(
    'historyQuery({instrument:"EURUSD",timeframe:"H1",before:100,limit:300})',
    context,
  );
  assert.equal(pending.length, 2);
  pending[0].resolve({ status: "pending" });
  pending[1].resolve({ status: "ready" });
  await Promise.all([a, b, c]);
  const d = vm.runInContext(
    'historyQuery({instrument:"EURUSD",timeframe:"M5",before:100,limit:300})',
    context,
  );
  assert.equal(
    pending.length,
    3,
    "completed planning response cannot hide newer coverage",
  );
  pending[2].reject(Error("offline"));
  await assert.rejects(d, /offline/);
  const e = vm.runInContext(
    'historyQuery({instrument:"EURUSD",timeframe:"M5",before:100,limit:300})',
    context,
  );
  assert.equal(pending.length, 4, "failed request must permit retry");
  pending[3].resolve({ status: "ready" });
  await e;
  assert.equal(vm.runInContext("historyRequests.size", context), 0);
  console.log(
    "Concurrent history reads share requests, distinct periods isolate, completion and failure clear entries",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
