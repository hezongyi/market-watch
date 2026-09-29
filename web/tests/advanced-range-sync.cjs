const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const context = vm.createContext({ Map, Set, Array });
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
const toggle = {
  ...changes,
  subscribe: (fn) => changes.subscribe(null, fn),
  unsubscribe: (fn) => changes.unsubscribe(null, fn),
  value: () => value,
  setValue: (v) => {
    if (v !== value) {
      value = v;
      changes.emit(v);
    }
  },
};
function chart() {
  const symbols = event(),
    callbacks = [];
  return {
    onSymbolChanged: () => symbols,
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
guard.dispose();
a.callbacks.shift()();
assert.equal(value, false, "disposed callback cannot restore old workspace");
assert.equal(a.symbols.listeners.size, 0);
console.log(
  "Range sync guard: concurrent loads, stale callbacks, disabled preference, removed panes and disposal passed",
);
