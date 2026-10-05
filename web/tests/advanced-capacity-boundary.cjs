const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const turn = () => new Promise((r) => setImmediate(r));
(async () => {
  const events = [],
    pending = [];
  const event = () => {
    const callbacks = new Map();
    return {
      subscribe(owner, callback) {
        callbacks.set(owner, callback);
      },
      unsubscribeAll(owner) {
        callbacks.delete(owner);
      },
      fire() {
        for (const callback of [...callbacks.values()]) callback();
      },
    };
  };
  const symbolEvent = event(),
    intervalEvent = event();
  const ctx = vm.createContext({
    Map,
    Set,
    Promise,
    Error,
    Number,
    Math,
    Date,
    performance: { now: () => Date.now() },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => setImmediate(cb),
    CustomEvent: class {
      constructor(type, args) {
        this.type = type;
        this.detail = args.detail;
      }
    },
    globalThis: { dispatchEvent: (e) => events.push(e) },
    URLSearchParams,
    location: { search: "" },
  });
  vm.runInContext(
    fs.readFileSync("../advanced-host/native-navigation.js", "utf8"),
    ctx,
  );
  const nav = ctx.globalThis.MWNativeNavigation;
  nav.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 100,
    workspace_bars: 150,
  });
  let bars = Array.from({ length: 60 }, (_, i) => ({
      time: (1000 + i) * 1000,
    })),
    offset = 0;
  const ts = {
    width: () => 100,
    barSpacing: () => 10,
    visibleBarsStrictRangeChanged: event,
    visibleBarsStrictRange: () => ({ firstBar: () => 0 }),
    points: () => ({
      range: () => ({
        value: () => ({ firstIndex: 0, lastIndex: bars.length - 1 }),
      }),
      valueAt: (i) => bars[i]?.time / 1000,
    }),
    baseIndex: () => bars.length - 1,
    setRightOffset: (v) => {
      offset = v;
    },
    requestMoreHistoryPoints() {},
  };
  const series = {
    symbol: () => "MWP:EURUSD",
    syncModel: () => null,
    dataEvents: () => ({ completed: event, dataUpdated: event }),
    onIntervalChanged: () => intervalEvent,
    symbolResolved: () => symbolEvent,
  };
  const m = {
    mainSeries: () => series,
    interval: () => "5",
    timeScale: () => ts,
    allStudies: () => [],
    fullUpdate() {},
    setExternalPosition(point) {
      this.lastExternal = point;
    },
    _updateTimeScale() {},
    gotoTime: () => Promise.resolve(),
    syncTimeWithModel: () => Promise.resolve(),
    gotoTimeRange: () => Promise.resolve(),
    resetTimeScale: () => Promise.resolve(),
  };
  nav.bindModel(m);
  await turn();
  const t = {
    _symbolInfo: { ticker: "MWP:EURUSD" },
    _resolution: "5",
    _cache: { bars },
    _dealignTime: (v) => v,
    _datafeed: {
      getBars: (info, res, p, cb, err) =>
        pending.push({ info, res, p, cb, err }),
    },
    _processBars(rows) {
      bars = [...rows, ...bars];
      this._cache.bars = bars;
    },
    _subscribeRealtimeIfNeeded() {},
    _purgeCache() { this._cache = { bars: [...bars] }; },
    _pendingSubscribers: [],
  };
  nav.bindThread(t, "5");
  nav.anchorThread(t);
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  let failure;
  t._datafeed.getBars(
    t._symbolInfo,
    "5",
    { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("original oversized request must not pretend success"),
    (e) => {
      failure = e;
      nav.historyFailure(t, e);
    },
  );
  await turn();
  await new Promise((r) => setTimeout(r, 5));
  await turn();
  assert.equal(failure.code, "NATIVE_HISTORY_CAPACITY_EXCEEDED");
  assert.equal(
    pending.length,
    1,
    "capacity fallback loads remaining 40 real bars instead of staying at latest",
  );
  assert.equal(pending[0].p.countBack, 40);
  assert.ok(
    pending[0].p.from >= pending[0].p.to - 1,
    "old rejected corridor is not sent again",
  );
  pending[0].cb(
    Array.from({ length: 40 }, (_, i) => ({ time: (960 + i) * 1000 })),
    { noData: false, mw_historyPages:2 },
  );
  await turn();
  await turn();
  assert.equal(
    t._cache.bars.length,
    100,
    "fallback fills actual single-source capacity",
  );
  assert.equal(
    offset,
    9 - 99,
    "viewport moves to earliest actual loaded points",
  );
  assert.ok(
    events.some(
      (e) =>
        e.type === "mw-capacity-state" &&
        e.detail.phase === "limited" &&
        e.detail.actual === 960,
    ),
  );
  const finalNotice = events.filter(e => e.type === "mw-capacity-state" && e.detail.phase === "limited").at(-1).detail;
  assert.equal(finalNotice.totalBars,40);
  assert.equal(finalNotice.loadedBars,40);
  assert.equal(finalNotice.pages,2,"completed batch pages accumulate in the boundary operation");
  assert.equal(finalNotice.started,events.find(e => e.type === "mw-capacity-state" && e.detail.phase === "filling").detail.started,
    "operation start remains stable throughout batch progress and completion");
  // Two panes own independent navigation intents over the same native source.
  // Moving one back to latest must leave the other pane's bounded fill alive.
  bars = Array.from({ length: 60 }, (_, i) => ({ time: (1000 + i) * 1000 }));
  t._cache.bars = bars;
  offset = 0;
  let peerOffset = 0;
  const peerScale = { ...ts, setRightOffset: value => { peerOffset = value; } };
  const peer = { ...m, timeScale: () => peerScale,
    setExternalPosition() {}, _updateTimeScale() {},
    gotoTime: () => Promise.resolve(), syncTimeWithModel: () => Promise.resolve(),
    gotoTimeRange: () => Promise.resolve(), resetTimeScale: () => Promise.resolve() };
  nav.bindModel(peer);
  await turn();
  nav.setCapabilities({ protocol: 1, mode: "continuous", max_bars: 100, workspace_bars: 300 });
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  peer._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  t._datafeed.getBars(t._symbolInfo, "5", { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("oversized shared request"), error => nav.historyFailure(t, error));
  await new Promise(resolve => setTimeout(resolve, 5));
  const sharedFill = pending.at(-1);
  assert.equal(nav.diagnostics().cursors.filter(state => state.phase === "loading").length, 2);
  await m.resetTimeScale();
  assert.equal(nav.filling(t), true, "a new intent on one pane preserves the peer's shared fill");
  assert.equal(sharedFill.info.mw_current(), true, "the peer still owns the in-flight HTTP consumer");
  sharedFill.cb(Array.from({ length: 40 }, (_, i) => ({ time: (960 + i) * 1000 })), { noData: false });
  await turn();
  await turn();
  assert.equal(t._cache.bars.length, 100, "remaining shared consumer completes capacity fill");
  assert.equal(peerOffset, -90, "remaining pane reaches the earliest real bar");
  assert.equal(offset, 0, "superseded pane is not moved by the peer's completion");
  // Repeat after data delivery, while native promotion waits on each pane.
  bars = Array.from({ length: 60 }, (_, i) => ({ time: (1000 + i) * 1000 }));
  t._cache.bars = bars;
  const points = ts.points;
  const unpromoted = () => ({ ...points(), range: () => ({
    value: () => ({ firstIndex: 10, lastIndex: bars.length - 1 }),
  }) });
  const peerCompleted = event();
  peer.mainSeries = () => ({ ...series,
    dataEvents: () => ({ completed: () => peerCompleted, dataUpdated: event }) });
  ts.points = unpromoted;
  peerScale.points = unpromoted;
  offset = peerOffset = 0;
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  peer._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  t._datafeed.getBars(t._symbolInfo, "5", { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("oversized promotion request"), error => nav.historyFailure(t, error));
  await new Promise(resolve => setTimeout(resolve, 5));
  pending.at(-1).cb(Array.from({ length: 40 }, (_, i) => ({ time: (960 + i) * 1000 })), { noData: false });
  await turn();
  await m.resetTimeScale();
  const offsetAfterReset = offset;
  peerScale.points = points;
  peerCompleted.fire();
  await turn();
  await turn();
  assert.equal(nav.filling(t), false, "detached pane cannot leave a promotion waiter blocking its peer");
  assert.equal(peerOffset, -90, "peer completes native promotion without the detached pane's event");
  assert.equal(offset, offsetAfterReset, "detached pane is not repositioned after promotion");
  ts.points = points;
  nav.unbindModel(peer);
  nav.setCapabilities({ protocol: 1, mode: "continuous", max_bars: 100, workspace_bars: 150 });
  bars = Array.from({ length: 60 }, (_, i) => ({ time: (1000 + i) * 1000 }));
  t._cache.bars = bars;
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  t._datafeed.getBars(
    t._symbolInfo,
    "5",
    { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("oversized"),
    (e) => nav.historyFailure(t, e),
  );
  await turn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const abandoned = pending.at(-1);
  nav.cancelAll();
  abandoned.cb(
    Array.from({ length: 40 }, (_, i) => ({ time: (960 + i) * 1000 })),
    { noData: false },
  );
  await turn();
  await turn();
  assert.equal(
    t._cache.bars.length,
    60,
    "late cancelled fill cannot insert bars",
  );
  assert.equal(
    nav.diagnostics().pending,
    0,
    "cancel releases shared workspace reservation",
  );
  nav.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 100,
    workspace_bars: 75,
  });
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  t._datafeed.getBars(
    t._symbolInfo,
    "5",
    { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("oversized"),
    (e) => nav.historyFailure(t, e),
  );
  await turn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    pending.at(-1).p.countBack,
    15,
    "fill honors tighter weighted workspace quota",
  );
  pending.at(-1).cb(
    Array.from({ length: 15 }, (_, i) => ({ time: (985 + i) * 1000 })),
    { noData: false },
  );
  await turn();
  await turn();
  assert.equal(t._cache.bars.length, 75);
  assert.equal(
    events
      .filter(
        (e) => e.type === "mw-capacity-state" && e.detail.phase === "limited",
      )
      .at(-1).detail.scope,
    "workspace",
  );
  const reads = pending.length;
  m._scrollingState = { targetDate: 700000, deferred: { reject() {} } };
  t._datafeed.getBars(
    t._symbolInfo,
    "5",
    { countBack: 100, from: 700, to: 985 },
    () => assert.fail("oversized"),
    (e) => nav.historyFailure(t, e),
  );
  await turn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await turn();
  assert.equal(
    pending.length,
    reads,
    "exhausted quota still locates boundary without requesting history",
  );
  symbolEvent.fire();
  m.setExternalPosition({ timeStamp: 700 }, {});
  assert.equal(
    m.lastExternal.timeStamp,
    700,
    "symbol identity change clears old boundary cursor gating",
  );
  nav.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 100,
    workspace_bars: 150,
  });
  bars = Array.from({ length: 60 }, (_, i) => ({ time: (1000 + i) * 1000 }));
  t._cache.bars = bars;
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  t._datafeed.getBars(
    t._symbolInfo,
    "5",
    { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("oversized"),
    (e) => nav.historyFailure(t, e),
  );
  await turn();
  await new Promise((r) => setTimeout(r, 5));
  pending.at(-1).cb([], { noData: false });
  await turn();
  await turn();
  const incomplete = events
    .filter(
      (e) => e.type === "mw-capacity-state" && e.detail.phase === "limited",
    )
    .at(-1).detail;
  assert.match(incomplete.message, /现有数据边界.*未完成/);
  assert.doesNotMatch(incomplete.message, /容量可到达/);
  assert.equal(
    incomplete.resident,
    60,
    "unresolved empty page cannot pretend capacity has been filled",
  );
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  t._datafeed.getBars(
    t._symbolInfo,
    "5",
    { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("oversized"),
    (e) => nav.historyFailure(t, e),
  );
  await turn();
  await new Promise((r) => setTimeout(r, 5));
  const oldFill = pending.at(-1);
  t._datafeed.getBars(
    t._symbolInfo,
    "5",
    { countBack: 5, from: 999, to: 1000 },
    () => {},
    () => {},
  );
  assert.equal(
    nav.filling(t),
    false,
    "same-source native read supersedes fill without racing reservations",
  );
  oldFill.cb(
    Array.from({ length: 40 }, (_, i) => ({ time: (960 + i) * 1000 })),
    { noData: false },
  );
  await turn();
  assert.equal(
    t._cache.bars.length,
    60,
    "superseded fill cannot apply old bars",
  );
  assert.equal(
    nav.diagnostics().pending,
    1,
    "superseded fill must not delete new request reservation",
  );
  t.mw_read.cancel();
  const originalPoints = ts.points;
  ts.points = () => ({...originalPoints(),range:() => ({value:() => ({firstIndex:10,lastIndex:bars.length-1})})});
  ts.requestMoreHistoryPoints = () => {
    ts.points = originalPoints;
    ts._requestingMoreData = true;
    t._datafeed.getBars(t._symbolInfo,"5",{countBack:100,from:700,to:1000},
      () => assert.fail("promotion oversized"),e => nav.historyFailure(t,e));
  };
  const promotionStart = events.length;
  m._scrollingState = {targetDate:800000,deferred:{reject(){}}};
  t._datafeed.getBars(t._symbolInfo,"5",{countBack:100,from:800,to:1000},
    () => assert.fail("oversized"),e => nav.historyFailure(t,e));
  await new Promise(r => setTimeout(r,5));
  pending.at(-1).cb(Array.from({length:40},(_,i)=>({time:(960+i)*1000})),{noData:false,mw_historyPages:2});
  await new Promise(r => setTimeout(r,10));
  const promotionEvents = events.slice(promotionStart).filter(e => e.type === "mw-capacity-state");
  const promotionDone = promotionEvents.filter(e => e.detail.phase === "limited").at(-1).detail;
  assert.equal(promotionDone.started,promotionEvents.find(e => e.detail.phase === "filling").detail.started);
  assert.equal(promotionDone.loadedBars,40,"native promotion preserves already completed operation bars");
  assert.equal(promotionDone.pages,2,"native promotion preserves accumulated pages");
  const beforePurge = pending.length;
  m._scrollingState = { targetDate: 800000, deferred: { reject() {} } };
  t._datafeed.getBars(
    t._symbolInfo, "5", { countBack: 100, from: 800, to: 1000 },
    () => assert.fail("oversized"), (e) => nav.historyFailure(t, e),
  );
  t._purgeCache();
  await new Promise((r) => setTimeout(r, 5));
  await turn();
  assert.equal(pending.length, beforePurge,
    "queued boundary intent cannot start against a purged source cache");
  const noticeCount = events.length;
  nav.unbindModel(m);
  assert.ok(events.slice(noticeCount).some(e => e.type === "mw-capacity-state" && e.detail.phase === "clear"),
    "removing the final source pane clears its persistent boundary result");
  console.log(
    "Capacity boundary: fill remaining quota, separate failed navigation, actual earliest viewport and notice passed",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
