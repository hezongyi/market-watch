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
  `
const planning = [];
historyQuery = async (args) => {
  planning.push({...args});
  return { status: "ready", requested_start: args.before - args.limit * 60000,
    next_cursor: args.before - args.limit * 60000 };
};
query = async (symbol, res, args) => ({bars: Array.from({length: args.limit}, (_, i) => ({
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
    query = async (symbol, res, args) => ({bars: [], has_more: false});
    historyQuery = async (args) => ({status:"ready", requested_start:args.before, next_cursor:args.before});
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
  console.log(
    "Large countBack traverses planned pages without truncation or duplicate bars",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
