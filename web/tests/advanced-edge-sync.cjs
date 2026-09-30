const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const timers = new Map();
let id = 0;
const context = vm.createContext({
  setTimeout: (fn) => {
    timers.set(++id, fn);
    return id;
  },
  clearTimeout: (id) => timers.delete(id),
});
vm.runInContext(
  fs.readFileSync(
    process.env.MARKET_WATCH_VIEWPORT_SOURCE || "../advanced-host/viewports.js",
    "utf8",
  ),
  context,
);
function watched(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    value: () => value,
    setValue: (v) => {
      value = v;
      for (const f of listeners) f(v);
    },
    subscribe: (f) => listeners.add(f),
    unsubscribe: (f) => listeners.delete(f),
  };
}
function pane(to, offset = 10) {
  const listeners = new Set(),
    changes = new Set();
  let bounds = { from: 100, to };
  return {
    onSymbolChanged: () => ({
      subscribe: (_, f) => changes.add(f),
      unsubscribe: (_, f) => changes.delete(f),
    }),
    onIntervalChanged: () => ({
      subscribe: (_, f) => changes.add(f),
      unsubscribe: (_, f) => changes.delete(f),
    }),
    change: () => {
      for (const f of changes) f();
    },
    resolution: () => "5",
    dataReady: () => true,
    getTimeScale: () => ({ rightOffset: () => offset }),
    getVisibleRange: () => bounds,
    setVisibleRange: async (r) => {
      bounds = { ...r };
    },
    onVisibleRangeChanged: () => ({
      subscribe: (_, f) => listeners.add(f),
      unsubscribe: (_, f) => listeners.delete(f),
    }),
    fire: () => {
      for (const f of listeners) f();
    },
    listeners,
  };
}
(async () => {
  const range = watched(true),
    time = watched(true),
    a = pane(1000),
    b = pane(3700, -100),
    c = pane(3700);
  let blocked = false,
    finish;
  const widget = {
    dateRangeSync: () => range,
    timeSync: () => time,
    activeChart: () => a,
    chartsCount: () => 3,
    chart: (i) => [a, b, c][i],
  };
  const guard = context.edgeRangeSync(
    widget,
    () => blocked,
    (e) => {
      throw e;
    },
  );
  async function flush() {
    const f = [...timers.values()];
    timers.clear();
    await Promise.all(f.map((f) => f()));
  }
  a.fire();
  assert.equal(guard.busy(), true);
  await flush();
  assert.equal(b.getVisibleRange().to, 1000);
  assert.equal(c.getVisibleRange().to, 1000);
  assert.equal(range.value(), true);
  assert.equal(time.value(), true);
  assert.equal(guard.busy(), false);
  // A peer can finish native history/range work after the active chart event.
  await b.setVisibleRange({ from: 100, to: 3700 });
  b.fire();
  await flush();
  assert.equal(
    b.getVisibleRange().to,
    1000,
    "late peer update follows the active chart",
  );
  range.setValue(false);
  a.fire();
  assert.equal(timers.size, 0);
  range.setValue(true);
  blocked = true;
  a.fire();
  assert.equal(timers.size, 0);
  blocked = false;
  b.getVisibleRange = () => ({ from: 100, to: 3700 });
  c.getVisibleRange = () => ({ from: 100, to: 3700 });
  b.setVisibleRange = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let cWrites = 0;
  c.setVisibleRange = async () => {
    cWrites++;
  };
  a.fire();
  const pending = flush();
  range.setValue(false);
  finish();
  await pending;
  assert.equal(cWrites, 0, "user toggle cancels remaining peer updates");
  assert.equal(range.value(), false, "user disabled sync must stay disabled");
  range.setValue(true);
  a.fire();
  const switched = flush();
  a.change();
  finish();
  await switched;
  assert.equal(
    cWrites,
    0,
    "period or symbol changes cancel remaining edge updates",
  );
  a.fire();
  const old = flush();
  guard.dispose();
  finish();
  await old;
  assert.equal(cWrites, 0);
  assert.equal(a.listeners.size, 0);
  assert.equal(range.value(), true);
  console.log(
    "Edge range synchronization: alignment, loading, user toggle and disposal passed",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
