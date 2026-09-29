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
    next_cursor: args.before - args.limit * 60000, bars: (await makePage(args)).bars };
};
const makePage = async (args) => ({bars: Array.from({length: args.limit}, (_, i) => ({
  start: args.before - (args.limit - i) * 60000,
  end: args.before - (args.limit - i - 1) * 60000,
  open: 1, high: 1, low: 1, close: 1,
})), has_more: true});
query = async () => { throw Error("ordinary OHLC must reuse planning response"); };
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
    historyQuery = async (args) => ({status:"ready", bars:[], requested_start:args.before, next_cursor:args.before});
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
    historyQuery = async (args) => {
      workspaceEpoch++;
      return {status:"ready", bars:(await makePage(args)).bars,
        requested_start:args.before-args.limit*60000};
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
    "Large countBack traverses planned pages without truncation or duplicate bars",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
