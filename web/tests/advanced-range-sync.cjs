const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const timers = new Map();
let timerId = 0;
const context = vm.createContext({ Map, Set, Array,
  setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
  clearTimeout: (id) => timers.delete(id),
});
vm.runInContext(
  fs.readFileSync("../advanced-host/range-sync.js", "utf8"),
  context,
);
function event() {
  const listeners = new Set();
  return {
    subscribe: (owner, fn) => listeners.add(fn),
    unsubscribe: (owner, fn) => listeners.delete(fn),
    emit: (v) => [...listeners].forEach((fn) => fn(v)),
    listeners,
  };
}
const changes = event();
let value = true;
let writes = 0;
const toggle = {
  ...changes,
  subscribe: (fn) => changes.subscribe(null, fn),
  unsubscribe: (fn) => changes.unsubscribe(null, fn),
  value: () => value,
  setValue: (v) => {
    writes++;
    if (v !== value) {
      value = v;
      changes.emit(v);
    }
  },
};
function chart() {
  const symbols = event(),
    intervals = event(),
    callbacks = [];
  return {
    onSymbolChanged: () => symbols,
    onIntervalChanged: () => intervals,
    intervals,
    dataReady: (cb) => callbacks.push(cb),
    symbols,
    callbacks,
  };
}
const a = chart(),
  b = chart();
let charts = [a, b];
const guard = context.rangeSyncLoadingGuard({
  dateRangeSync: () => toggle,
  chartsCount: () => charts.length,
  chart: (i) => charts[i],
});
assert.equal(
  writes,
  0,
  "initial binding must not write an unchanged native preference",
);
guard.refresh();
assert.equal(writes, 0, "refresh must not add redundant native undo commands");
a.intervals.emit();
assert.equal(value, false);
for (const fn of [...timers.values()]) fn();
assert.equal(guard.busy(), true, "elapsed time alone must not release a slow history load");
a.callbacks.shift()();
assert.equal(value, true);
a.symbols.emit();
b.symbols.emit();
assert.equal(value, false);
assert.equal(guard.busy(), true);
a.callbacks.shift()();
assert.equal(value, false);
b.callbacks.shift()();
assert.equal(value, true);
a.symbols.emit();
a.symbols.emit();
a.callbacks.shift()();
assert.equal(guard.busy(), true);
a.callbacks.shift()();
assert.equal(value, true);
a.symbols.emit();
b.symbols.emit();
const emptyA = guard.captureTerminalCompletion((chart) => chart === a);
emptyA();
assert.equal(guard.busy(), true, "empty pane must not unlock another loading pane");
b.callbacks.shift()();
assert.equal(guard.busy(), false);
a.callbacks.shift()();
a.symbols.emit();
const staleEmpty = guard.captureTerminalCompletion(() => true);
a.symbols.emit();
staleEmpty();
assert.equal(guard.busy(), true, "old empty result must not release a newer load");
a.callbacks.shift()();
a.callbacks.shift()();
assert.equal(guard.busy(), false);
toggle.setValue(false);
a.symbols.emit();
a.callbacks.shift()();
assert.equal(value, false, "preserve disabled user preference");
toggle.setValue(true);
b.symbols.emit();
charts = [a];
guard.refresh();
assert.equal(value, true);
assert.equal(b.symbols.listeners.size, 0);
b.callbacks.shift()();
assert.equal(value, true);
a.symbols.emit();
assert.equal(
  value,
  true,
  "single pane has no peer to synchronize during loading",
);
const disposedEmpty = guard.captureTerminalCompletion(() => true);
guard.dispose();
disposedEmpty();
a.callbacks.shift()();
assert.equal(value, true, "disposed callback cannot change old workspace");
assert.equal(a.symbols.listeners.size, 0);
console.log(
  "Range sync guard: concurrent loads, stale callbacks, disabled preference, removed panes and disposal passed",
);
