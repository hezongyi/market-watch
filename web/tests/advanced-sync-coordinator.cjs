const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const callbacks = new Map();
let rafId = 0;
const ctx = vm.createContext({
  requestAnimationFrame: (fn) => {
    callbacks.set(++rafId, fn);
    return rafId;
  },
  cancelAnimationFrame: (id) => callbacks.delete(id),
});
vm.runInContext(
  fs.readFileSync("../advanced-host/sync-coordinator.js", "utf8"),
  ctx,
);
function event() {
  const listeners = new Set();
  return {
    subscribe: (o, f) => listeners.add(f),
    unsubscribe: (o, f) => listeners.delete(f),
    emit: (v) => [...listeners].forEach((f) => f(v)),
    listeners,
  };
}
function watched(value) {
  const e = event();
  return {
    value: () => value,
    setValue: (v) => {
      if (v === value) return;
      value = v;
      e.emit(v);
    },
    subscribe: (f) => e.subscribe(null, f),
    unsubscribe: (f) => e.unsubscribe(null, f),
  };
}
const inputs = { event: { isTrusted: true } },
  date = watched(false),
  time = watched(false),
  events = new Map();
let focus = 0,
  dirty = 0;
function chart() {
  const symbol = event(),
    interval = event();
  let spacing = 6,
    writes = 0;
  const model = {};
  return {
    symbol: () => "MWP:EURUSD",
    resolution: () => "5",
    chartType: () => 1,
    dataReady: () => true,
    onSymbolChanged: () => symbol,
    onIntervalChanged: () => interval,
    _chartWidget: {
      model: () => ({ model: () => model }),
      ownerDocument: () => ({ defaultView: inputs }),
    },
    model,
    getTimeScale: () => ({
      barSpacing: () => spacing,
      setBarSpacing: (v) => {
        spacing = v;
        writes++;
      },
    }),
    writes: () => writes,
  };
}
const charts = [chart(), chart(), chart()];
const widget = {
  dateRangeSync: () => date,
  timeSync: () => time,
  chartsCount: () => charts.length,
  chart: (i) => charts[i],
  activeChart: () => charts[focus],
  subscribe: (k, f) => {
    if (!events.has(k)) events.set(k, new Set());
    events.get(k).add(f);
  },
  unsubscribe: (k, f) => events.get(k)?.delete(f),
};
const c = ctx.chartSyncCoordinator(widget, { changed: () => dirty++ });
ctx.MWSyncCoordinator = c;
const flush = () => {
  for (const [id, fn] of [...callbacks]) {
    callbacks.delete(id);
    fn();
  }
};
c.select("barWidth", true);
assert.equal(charts[1].writes(), 0, "enabling must not synchronize");
assert.equal(
  c.select("date", true),
  false,
  "date cannot replace bar-width mode",
);
const token = c.begin(charts[0].model, "wheel");
c.step(token, () => charts[0].getTimeScale().setBarSpacing(9));
c.step(token, () => charts[0].getTimeScale().setBarSpacing(10));
c.end(token);
flush();
assert.equal(charts[1].getTimeScale().barSpacing(), 10);
assert.equal(charts[1].writes(), 1, "one latest peer update per frame");
charts[0].getTimeScale().setBarSpacing(11);
assert.equal(
  charts[1].getTimeScale().barSpacing(),
  10,
  "programmatic changes are not propagated",
);
// Hovered chart accepts wheel without becoming the active chart.
focus = 0;
const hovered = c.begin(charts[2].model, "wheel");
assert.ok(hovered, "non-active chart user zoom must be admitted");
c.step(hovered, () => charts[2].getTimeScale().setBarSpacing(12));
c.end(hovered);
flush();
assert.equal(charts[0].getTimeScale().barSpacing(), 12);
assert.equal(charts[1].getTimeScale().barSpacing(), 12);
const animation = c.begin(charts[2].model, "zoom-in");
c.step(animation, () => charts[2].getTimeScale().setBarSpacing(13));
focus = 1;
for (const f of events.get("activeChartChanged") || []) f();
c.step(animation, () => charts[2].getTimeScale().setBarSpacing(14));
c.end(animation);
flush();
assert.equal(charts[1].getTimeScale().barSpacing(), 14, "actual user action remains source across a focus-only change");
const stale = c.begin(charts[2].model, "zoom-in");
c.step(stale, () => charts[2].getTimeScale().setBarSpacing(15));
for (const f of events.get("layout_about_to_be_changed")) f();
c.step(stale, () => charts[2].getTimeScale().setBarSpacing(16));
flush();
assert.equal(charts[1].getTimeScale().barSpacing(), 14, "layout invalidates queued and animated steps");
inputs.event.isTrusted = false;
assert.equal(c.begin(charts[0].model, "zoom-in"), undefined);
inputs.event.isTrusted = true;
c.select("barWidth", false);
c.select("date", true);
const rev = dirty,
  a = c.acquirePause("a", ["date", "time"]),
  b = c.acquirePause("b", ["date", "time"]);
assert.equal(date.value(), false);
assert.equal(c.snapshot().date, true);
assert.equal(dirty, rev, "pause does not edit choice");
a.release();
a.release();
assert.equal(date.value(), false);
c.configure({ date: false, time: true });
b.release();
assert.equal(date.value(), false);
assert.equal(time.value(), true, "last release applies latest choices");
const old = c.acquirePause("old");
c.resetWorkspace({ date: true, time: false });
old.release();
assert.equal(date.value(), true, "old release cannot write new workspace");
c.dispose();
assert.equal(c.diagnostics().bindings, 0);
assert.equal(c.diagnostics().pauses, 0);
assert.equal((events.get("activeChartChanged")?.size || 0), 0);
console.log(
  "Sync coordinator input, coalescing, cancellation, exclusion, nested/latest/old pauses and cleanup: PASS",
);
