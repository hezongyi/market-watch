const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const run = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  const ctx = vm.createContext({
    Map,
    Set,
    Promise,
    Error,
    Number,
    Math,
    performance: { now: () => Date.now() },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => setImmediate(cb),
    CustomEvent: class {},
    globalThis: { dispatchEvent() {} },
    location: { search: "" },
    URLSearchParams,
  });
  vm.runInContext(
    fs.readFileSync("../advanced-host/native-navigation.js", "utf8"),
    ctx,
  );
  const navigation = ctx.globalThis.MWNativeNavigation;
  navigation.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 100,
    workspace_bars: 150,
  });
  const pending = [];
  let delivered = 0,
    failed = 0;
  const thread = () => ({
    _symbolInfo: { ticker: "MWP:EURUSD" },
    _cache: { bars: [] },
    _datafeed: { getBars: (s, r, p, cb, err) => pending.push({ s, cb, err }) },
    _dealignTime: (t) => t,
    _purgeCache() {
      this._cache = { bars: [] };
    },
    _resolution: "5",
  });
  const one = thread(),
    two = thread();
  two._symbolInfo.ticker = "MWP:GBPUSD";
  navigation.bindThread(one, "5");
  navigation.bindThread(two, "5");
  one._datafeed.getBars(
    one._symbolInfo,
    "5",
    { countBack: 100 },
    () => delivered++,
    () => failed++,
  );
  two._datafeed.getBars(
    two._symbolInfo,
    "5",
    { countBack: 100 },
    () => delivered++,
    () => failed++,
  );
  await run();
  assert.equal(failed, 1, "concurrent sources reserve workspace capacity");
  assert.equal(pending.length, 1);
  one.mw_read.cancel();
  assert.equal(failed, 2);
  assert.equal(pending[0].s.mw_current(), false);
  pending[0].cb([{ time: 1 }], {});
  assert.equal(delivered, 0, "obsolete callbacks cannot populate native cache");
  assert.equal(
    navigation.diagnostics().pending,
    0,
    "failure releases reservation",
  );
  one._datafeed.getBars(
    one._symbolInfo,
    "5",
    { countBack: 10 },
    () => delivered++,
    () => failed++,
  );
  one._purgeCache();
  assert.equal(failed, 3, "purging a source finishes its native callback");
  pending[1].cb([{ time: 2 }], {});
  assert.equal(delivered, 0);
  navigation.unbindThread(one);
  navigation.unbindThread(two);
  assert.equal(navigation.diagnostics().threads, 0);
  const bounded = thread();
  bounded._cache.bars = Array.from({ length: 80 }, (_, time) => ({ time }));
  navigation.bindThread(bounded, "5");
  let budgetError;
  bounded._datafeed.getBars(
    bounded._symbolInfo,
    "5",
    { countBack: 21 },
    () => {},
    (e) => {
      budgetError = e;
    },
  );
  await run();
  assert.equal(budgetError.budget_scope, "source");
  assert.equal(budgetError.projected_bars, 101);
  assert.equal(budgetError.max_bars, 100);
  assert.match(budgetError.message, /M5.*101.*100.*更近日期/);
  assert.equal(navigation.diagnostics().pending, 0);
  const callsBefore = pending.length;
  bounded._datafeed.getBars(
    bounded._symbolInfo,
    "5",
    { countBack: 10 },
    () => {},
    () => {},
  );
  assert.equal(
    pending.length,
    callsBefore + 1,
    "in-budget uncached read proceeds after real admission rejection",
  );
  bounded.mw_read.cancel();
  navigation.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 120,
    workspace_bars: 200,
  });
  const raisedCalls = pending.length;
  bounded._datafeed.getBars(
    bounded._symbolInfo,
    "5",
    { countBack: 21 },
    () => {},
    (e) => {
      if (e.code !== "HISTORY_CANCELLED") throw e;
    },
  );
  assert.equal(
    pending.length,
    raisedCalls + 1,
    "raising capacity admits the previously rejected request without reset",
  );
  bounded.mw_read.cancel();
  navigation.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 50,
    workspace_bars: 100,
  });
  assert.doesNotThrow(
    () => navigation.admitCached(bounded, [{ time: 1 }]),
    "lowering capacity preserves navigation in resident data",
  );
  assert.throws(
    () => navigation.admitCached(bounded, [{ time: 81 }]),
    /容量/,
    "lowered limit still rejects new growth",
  );
  navigation.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 100,
    workspace_bars: 150,
  });
  navigation.unbindThread(bounded);
  // Pending asynchronous creations must be charged before studies appear in
  // allStudies. Cancellation and rejection release the reservation.
  const event = () => ({ subscribe() {}, unsubscribeAll() {} });
  const studies = [],
    created = [];
  const series = {
    symbol: () => "MWP:EURUSD",
    syncModel: () => null,
    dataEvents: () => ({
      completed: event,
      dataUpdated: event,
    }),
    onIntervalChanged: event,
    symbolResolved: event,
  };
  let externalCalls = 0;
  const model = {
    mainSeries: () => series,
    interval: () => "5",
    crosshairSource: () => ({
      isOnHoveredChartWidget: () => false,
      appliedIndex: () => 0,
    }),
    timeScale: () => ({ visibleBarsStrictRangeChanged: event }),
    setExternalPosition() {
      externalCalls++;
    },
    _updateTimeScale() {},
    allStudies: () => studies,
    insertStudyWithParams() {
      let resolve, reject;
      const study = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      const handle = { study, cancel() {} };
      created.push({
        resolve: (value) => {
          studies.push(value);
          resolve(value);
        },
        reject,
      });
      return handle;
    },
  };
  const shared = thread();
  shared._cache.bars = Array.from({ length: 80 }, (_, time) => ({ time }));
  navigation.bindThread(shared, "5");
  navigation.bindModel(model);
  await run();
  const firstStudy = model.insertStudyWithParams({});
  assert.throws(
    () => model.insertStudyWithParams({}),
    /容量/,
    "parallel insertion reserves cost",
  );
  firstStudy.cancel();
  const nextStudy = model.insertStudyWithParams({});
  created[1].reject(Error("study creation failed"));
  await run();
  model.insertStudyWithParams({});
  created[2].resolve({});
  await run();
  assert.throws(
    () => model.insertStudyWithParams({}),
    /容量/,
    "resolved study remains charged",
  );
  navigation.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 50,
    workspace_bars: 100,
  });
  assert.doesNotThrow(
    () => navigation.admitTemplate(model, { panes: [] }),
    "lowering capacity must still allow reducing indicator load",
  );
  navigation.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 100,
    workspace_bars: 150,
  });
  assert.doesNotThrow(() =>
    navigation.admitTemplate(model, {
      panes: [
        {
          sources: [
            { type: "MainSeries" },
            { type: "LineToolHorzLine" },
            { type: "Study" },
          ],
        },
      ],
    }),
  );
  assert.throws(
    () =>
      navigation.admitTemplate(model, {
        panes: [{ sources: [{ type: "Study" }, { type: "Study" }] }],
      }),
    /容量/,
    "template replacement is admitted before pane mutation",
  );
  const light = { panes: [{ sources: [{ type: "Study" }] }] },
    heavy = { panes: [{ sources: [{ type: "Study" }, { type: "Study" }] }] };
  const templateCommand = {
    _model: model,
    _initialState: heavy,
    _templateContent: light,
  };
  assert.doesNotThrow(() => navigation.admitHistory(templateCommand, "redo"));
  assert.throws(
    () =>
      navigation.admitHistory({ commands: () => [templateCommand] }, "undo"),
    /容量/,
    "nested macro preflight rejects before native history pops or runs commands",
  );
  shared._cache.bars = shared._cache.bars.slice(0, 40);
  studies.length = 0;
  const peerModel = {
    ...model,
    mainSeries: () => ({ ...series, symbol: () => "MWP:GBPUSD" }),
    allStudies: () => [],
  };
  const peerThread = thread();
  peerThread._symbolInfo.ticker = "MWP:GBPUSD";
  peerThread._cache.bars = Array.from({ length: 40 }, (_, time) => ({ time }));
  navigation.bindThread(peerThread, "5");
  navigation.bindModel(peerModel);
  await run();
  const peerCommand = {
    _model: peerModel,
    _initialState: heavy,
    _templateContent: light,
  };
  assert.doesNotThrow(() => navigation.admitHistory(templateCommand, "undo"));
  assert.doesNotThrow(() => navigation.admitHistory(peerCommand, "undo"));
  assert.throws(
    () =>
      navigation.admitHistory(
        { commands: () => [templateCommand, peerCommand] },
        "undo",
      ),
    /容量/,
    "macro admission accumulates projected costs across charts before popping",
  );
  assert.throws(
    () =>
      navigation.admitCheckpoint(
        { _commands: [templateCommand, peerCommand] },
        {},
      ),
    /容量/,
    "checkpoint preflight accumulates costs before its first mutation",
  );
  assert.doesNotThrow(() =>
    navigation.admitCheckpoint(
      { _commands: [templateCommand, peerCommand] },
      { lastActualCommand: templateCommand },
    ),
  );
  navigation.unbindModel(peerModel);
  navigation.unbindThread(peerThread);
  nextStudy.cancel();
  let finishOld;
  let engineCurrent;
  const oldRange = navigation
    .prepareRange(
      model,
      {},
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
          engineCurrent = navigation.engineRangeCurrent();
        }),
    )
    .then(
      () => "completed",
      (e) => e.code,
    );
  assert.ok(engineCurrent());
  assert.equal(
    await navigation.prepareRange(model, {}, () => Promise.resolve("new")),
    "new",
  );
  assert.equal(
    await oldRange,
    "HISTORY_CANCELLED",
    "public promise finishes at supersession",
  );
  assert.equal(
    engineCurrent(),
    false,
    "engine range application observes model generation",
  );
  finishOld("late");
  await run();
  const cursorSource = {
    ...model,
    _syncCrosshair: () => model.setExternalPosition({ timeStamp: 9 }, {}),
  };
  navigation.bindModel(cursorSource);
  await run();
  cursorSource._syncCrosshair();
  navigation.unbindModel(cursorSource);
  const sourceClosedCalls = externalCalls;
  navigation.timeScaleUpdated(model);
  assert.equal(
    externalCalls,
    sourceClosedCalls,
    "unloading a cursor source invalidates retained peer replay",
  );
  let sourceResolution = "1D",
    sourceSymbol = "MWP:EURUSD";
  const intervalHandlers = [],
    symbolHandlers = [];
  const sourceEvent = (handlers) => ({
    subscribe: (_, callback) => handlers.push(callback),
    unsubscribeAll() {},
  });
  const intervalEvent = sourceEvent(intervalHandlers),
    symbolEvent = sourceEvent(symbolHandlers);
  const identitySource = {
    ...model,
    interval: () => sourceResolution,
    mainSeries: () => ({
      ...series,
      symbol: () => sourceSymbol,
      onIntervalChanged: () => intervalEvent,
      symbolResolved: () => symbolEvent,
    }),
    _syncCrosshair: () => model.setExternalPosition({ timeStamp: 9 }, {}),
  };
  navigation.bindModel(identitySource);
  await run();
  for (const kind of ["interval", "symbol"]) {
    identitySource._syncCrosshair();
    assert.ok(navigation.diagnostics().cursors.some((c) => c.time === 9));
    if (kind === "interval") sourceResolution = "240";
    else sourceSymbol = "MWP:GBPUSD";
    for (const callback of kind === "interval"
      ? intervalHandlers
      : symbolHandlers)
      callback();
    const cleared = externalCalls;
    navigation.timeScaleUpdated(model);
    await run();
    await run();
    assert.equal(
      externalCalls,
      cleared,
      `${kind} identity change invalidates old peer replay`,
    );
    assert.ok(
      navigation.diagnostics().cursors.every((c) => c.time === undefined),
    );
  }
  identitySource._syncCrosshair();
  assert.ok(
    navigation.diagnostics().cursors.some((c) => c.time === 9),
    "fresh native broadcast remains valid after identity change",
  );
  navigation.unbindModel(identitySource);
  model.setExternalPosition({ timeStamp: 10 }, {});
  navigation.timeScaleUpdated(model);
  model.setExternalPosition(null);
  const clearedCalls = externalCalls;
  await run();
  await run();
  assert.equal(
    externalCalls,
    clearedCalls,
    "cleared semantic cursor cannot replay after time-scale work",
  );
  model.setExternalPosition({ timeStamp: 20 }, {});
  navigation.timeScaleUpdated(model);
  navigation.unbindModel(model);
  navigation.unbindThread(shared);
  const destroyedCalls = externalCalls;
  await run();
  await run();
  assert.equal(
    externalCalls,
    destroyedCalls,
    "destroyed source cannot replay queued cursor",
  );
  console.log(
    "Continuous navigation: concurrent admission, cancellation, stale callbacks, source purge and release passed",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
