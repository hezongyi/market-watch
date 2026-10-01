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
  const failures = [];
  let blocked = false,
    finish;
  let delayPreparation = false, finishPreparation;
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
    (e) => failures.push(e),
    (peer,target) => delayPreparation && peer === c
      ? new Promise(resolve => {finishPreparation = () => resolve(target);}) : target,
  );
  async function waitForPeer() {
    for(let i=0;i<30 && !finish;i++) await Promise.resolve();
    assert.equal(typeof finish,"function","peer update must start");
  }
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
  // Wheel zoom can leave the right boundary fixed while moving only the left.
  await a.setVisibleRange({from:700,to:1000});
  a.fire();
  await flush();
  assert.equal(b.getVisibleRange().from,700,'left-only zoom must synchronize');
  assert.equal(c.getVisibleRange().from,700,'all peers must follow zoom');
  await a.setVisibleRange({from:100,to:1000});
  a.fire();
  await flush();
  // A peer can finish native history/range work after the active chart event.
  await b.setVisibleRange({ from: 100, to: 3700 });
  b.fire();
  await flush();
  assert.equal(
    b.getVisibleRange().to,
    1000,
    "late peer update follows the active chart",
  );
  // An unavailable range on one peer must not prevent later peers aligning.
  const setB = b.setVisibleRange;
  await b.setVisibleRange({from:100,to:3700});
  await c.setVisibleRange({from:100,to:3700});
  b.setVisibleRange = async () => { throw Error('Invalid visible range'); };
  a.fire();
  await flush();
  assert.equal(c.getVisibleRange().to, 1000, 'failed peer must not block later peers');
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /Invalid visible range/);
  assert.equal(guard.busy(), false);
  assert.equal(range.value(), true);
  assert.equal(time.value(), true);
  b.setVisibleRange = setB;
  // While a peer is loading, another wheel gesture must survive the busy guard.
  await b.setVisibleRange({from:100,to:3700});
  await c.setVisibleRange({from:100,to:3700});
  b.setVisibleRange = r => new Promise(resolve => {
    finish = async () => { await setB(r); resolve(); };
  });
  finish = undefined;
  a.fire();
  const changing = flush();
  await waitForPeer();
  assert.equal(c.getVisibleRange().to,1000,'a slow peer must not block other panes');
  await a.setVisibleRange({from:600,to:1000});
  a.fire();
  await finish();
  await changing;
  b.setVisibleRange = setB;
  assert.equal(guard.busy(),true,'latest wheel intent must be scheduled');
  await flush();
  assert.equal(b.getVisibleRange().from,600);
  assert.equal(c.getVisibleRange().from,600);
  await a.setVisibleRange({from:100,to:1000});
  a.fire();
  await flush();
  range.setValue(false);
  a.fire();
  assert.equal(timers.size, 0);
  range.setValue(true);
  blocked = true;
  a.fire();
  assert.equal(timers.size, 1,'blocked interaction must be retained');
  await flush();
  assert.equal(timers.size,1,'loading postpones reconciliation');
  blocked = false;
  await flush();
  b.getVisibleRange = () => ({ from: 100, to: 3700 });
  c.getVisibleRange = () => ({ from: 100, to: 3700 });
  b.setVisibleRange = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let cWrites = 0;
  delayPreparation = true;
  c.setVisibleRange = async () => {
    cWrites++;
  };
  finish = undefined;
  a.fire();
  const pending = flush();
  await waitForPeer();
  range.setValue(false);
  finishPreparation();
  finish();
  await pending;
  assert.equal(cWrites, 0, "user toggle cancels remaining peer updates");
  assert.equal(range.value(), false, "user disabled sync must stay disabled");
  range.setValue(true);
  finish = undefined;
  a.fire();
  const switched = flush();
  await waitForPeer();
  a.change();
  finishPreparation();
  finish();
  await switched;
  assert.equal(
    cWrites,
    0,
    "period or symbol changes cancel remaining edge updates",
  );
  finish = undefined;
  a.fire();
  const old = flush();
  await waitForPeer();
  guard.dispose();
  finishPreparation();
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
