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
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), context);
vm.runInContext(
  `
const planning = [];
request = async (args) => {
  if(args.op==='dataset') return {ready:true,start:0,revision:1};
  assertPublished(args);
  planning.push({...args});
  return makePage(args);
};
function assertPublished(args) {
  if(!args.published || args.series_kind!=='managed') throw Error('expected published managed read');
}
const makePage = async (args) => ({bars: Array.from({length: args.limit}, (_, i) => ({
  start: args.before - (args.limit - i) * 60000,
  end: args.before - (args.limit - i - 1) * 60000,
  open: 1, high: 1, low: 1, close: 1,
})), has_more: true});
`,
  context,
);
(async () => {
  const result = await vm.runInContext(
    `new Promise((resolve,reject) =>
    feed.getBars({ticker:"EURUSD"}, "1", {to: 2000000, countBack: 4500, firstDataRequest:true},
      (bars,meta) => resolve({bars,meta}), reject))`,
    context,
  );
  assert.equal(result.bars.length, 4500);
  assert.equal(result.bars.at(-1).time, 2000000000 - 60000);
  assert.equal(new Set(result.bars.map((b) => b.time)).size, 4500);
  assert.deepEqual(
    JSON.parse(
      vm.runInContext("JSON.stringify(planning.map(p=>p.limit))", context),
    ),
    [2000, 2000, 500],
  );
  assert.equal(
    vm.runInContext('firstHistory.get("EURUSD|1")', context),
    result.bars[0].time,
  );
  vm.runInContext(
    `
    request = async (args) => ({bars:[],has_more:true});
  `,
    context,
  );
  await assert.rejects(
    vm.runInContext(
      `new Promise((resolve,reject) =>
    feed.getBars({ticker:"EURUSD"}, "1", {to:2000000,countBack:300}, resolve,reject))`,
      context,
    ),
    (error) => String(error).includes("历史分页未推进"),
  );
  vm.runInContext(
    `
    const notices = [];
    parent.postMessage = (message) => notices.push(message);
    cache.clear();
    request = async (args) => {
      workspaceEpoch++;
      return makePage(args);
    };
  `,
    context,
  );
  await assert.rejects(
    vm.runInContext(
      `new Promise((resolve,reject) =>
    feed.getBars({ticker:"EURUSD"}, "1", {to:2000000,countBack:300}, resolve,reject))`,
      context,
    ),
    (error) => String(error).includes("已取消"),
  );
  assert.equal(
    vm.runInContext('notices.filter(n => n.type === "error").length', context),
    0,
    "cancelled old workspace must not show an error over the new workspace",
  );
  console.log(
    "Large countBack traverses published pages without truncation or duplicate bars",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
