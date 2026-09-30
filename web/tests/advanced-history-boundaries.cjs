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
vm.runInContext(`
progressivePages={get:async args=>({bars:[{start:args.before-60000,end:args.before,open:1,high:1,low:1,close:1}]})};
`,context);
(async()=>{
 for(const [to,firstDataRequest] of [[2000000,true],[1000000,false],[2100000,true]]) {
  await vm.runInContext(`new Promise((resolve,reject)=>feed.getBars({ticker:"EURUSD"},"1",
   {to:${to},countBack:1,firstDataRequest:${firstDataRequest}},resolve,reject))`,context);
 }
 assert.equal(vm.runInContext('lastHistory.get("EURUSD|1")',context),2100000000-60000);
 assert.equal(vm.runInContext('firstHistory.get("EURUSD|1")',context),1000000000-60000);
 console.log('Progressive pagination preserves latest subscription boundary and earliest revision range');
})().catch(e=>{console.error(e);process.exit(1)});
