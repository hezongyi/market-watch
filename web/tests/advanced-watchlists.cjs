const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const context = vm.createContext({
  setTimeout,
  clearTimeout,
  Promise,
  JSON,
  Object,
  Array,
});
vm.runInContext(
  fs.readFileSync("../advanced-host/watchlists.js", "utf8"),
  context,
);
(async () => {
  const handlers = [];
  let lists = { a: { id: "a", title: "A", symbols: ["EURUSD"] } },
    active = "a";
  const api = {
    getAllLists: () => lists,
    getActiveListId: () => active,
    getList: () => lists[active]?.symbols,
    deleteList: (id) => delete lists[id],
    saveList: (r) => (lists[r.id] = r),
    setActiveList: (id) => (active = id),
    updateList: (id, s) => (lists[id].symbols = s),
  };
  for (const event of [
    "onListChanged",
    "onActiveListChanged",
    "onListAdded",
    "onListRemoved",
    "onListRenamed",
  ])
    api[event] = () => ({ subscribe: (_, fn) => handlers.push(fn) });
  let calls = 0,
    errors = 0;
  await context.nativeWatchlists(
    { watchList: async () => api },
    null,
    false,
    async () => {
      calls++;
      if (calls === 1) throw Error("offline");
    },
    () => errors++,
  );
  await delay(150);
  assert.equal(errors, 1);
  handlers[0]();
  await delay(150);
  assert.equal(calls, 2, "failed snapshot must be retried on the next event");
  const count = handlers.length;
  await context.nativeWatchlists(
    { watchList: async () => api },
    { lists: [], active: null },
    true,
    async () => {
      throw Error("readonly write");
    },
    () => {},
  );
  assert.equal(handlers.length, count);
  assert.equal(
    Object.keys(lists).length,
    0,
    "an intentionally empty list collection stays empty",
  );
  console.log(
    "Watchlist failed save retry and readonly empty restoration passed",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
