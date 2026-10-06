// Reproduce native public/internal watched values, Undo commands and save cleanup
// using the handlers extracted from a privately patched licensed bundle.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  vm = require("node:vm"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../.."),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "mw-sync-native-choice-")),
  file = path.join(temp, "library.js");
try {
  fs.copyFileSync(
    path.join(
      root,
      "advanced-host/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js",
    ),
    file,
  );
  execFileSync(process.execPath, [
    path.join(root, "advanced-host/patch-native-reserve.mjs"),
    file,
  ]);
  const bundle = fs.readFileSync(file, "utf8");
  const watched = (initial) => {
    let value = initial;
    const listeners = new Set();
    return {
      value: () => value,
      setValue(v) {
        if (value === v) return;
        value = v;
        [...listeners].forEach((f) => f(v));
      },
      subscribe: (f) => listeners.add(f),
      unsubscribe: (f) => listeners.delete(f),
    };
  };
  const stack = [],
    redo = [];
  const undoHistory = {
    setWatchedValue(target, value, label) {
      const old = target.value();
      if (old === value) return;
      const command = {
        undo: () => target.setValue(old),
        redo: () => target.setValue(value),
        label,
      };
      stack.push(command);
      redo.length = 0;
      command.redo();
    },
    undo() {
      const c = stack.pop();
      assert.ok(c);
      c.undo();
      redo.push(c);
    },
    redo() {
      const c = redo.pop();
      assert.ok(c);
      c.redo();
      stack.push(c);
    },
  };
  const date = watched(false),
    time = watched(false),
    internalDate = watched(false),
    internalTime = watched(false);
  const collection = {
    undoHistory,
    _loadingContent: false,
    _internalDateRangeLock: internalDate,
    _internalTrackTimeLock: internalTime,
  };
  const chart = {
    chartType: () => 1,
    onSymbolChanged: () => ({ subscribe() {}, unsubscribe() {} }),
    onIntervalChanged: () => ({ subscribe() {}, unsubscribe() {} }),
  };
  const widget = {
    _innerAPI: () => ({ _chartWidgetCollection: collection }),
    dateRangeSync: () => date,
    timeSync: () => time,
    chartsCount: () => 1,
    chart: () => chart,
    subscribe() {},
    unsubscribe() {},
  };
  const context = vm.createContext({
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    Cf: "date",
    Tf: "time",
  });
  context.parent = context;
  context.collection = collection;
  vm.runInContext(
    fs.readFileSync(
      path.join(root, "advanced-host/sync-coordinator.js"),
      "utf8",
    ),
    context,
  );
  for (const name of [
    "_handleDateRangeLockChange",
    "_handleTrackTimeLockChange",
  ]) {
    const start = bundle.indexOf(name + "(e){"),
      end = bundle.indexOf("}_", start);
    assert.ok(start >= 0 && end > start);
    collection[name] = vm
      .runInContext(
        `(function(e){${bundle.slice(start + name.length + 4, end)}})`,
        context,
      )
      .bind(collection);
  }
  internalDate.subscribe((v) => date.setValue(v));
  internalTime.subscribe((v) => time.setValue(v));
  date.subscribe((v) => collection._handleDateRangeLockChange(v));
  time.subscribe((v) => collection._handleTrackTimeLockChange(v));
  const coordinator = context.chartSyncCoordinator(widget);
  context.MWSyncCoordinator = coordinator;
  for (const key of ["date", "time"]) {
    coordinator.resetWorkspace({ date: false, time: false });
    stack.length = 0;
    redo.length = 0;
    const toggle = key === "date" ? date : time;
    coordinator.select(key, true);
    assert.equal(stack.length, 1);
    assert.equal(toggle.value(), true);
    const pause = coordinator.acquirePause("save", [key]);
    assert.equal(stack.length, 1);
    assert.equal(toggle.value(), false);
    undoHistory.undo();
    assert.equal(coordinator.snapshot()[key], false);
    undoHistory.redo();
    assert.equal(coordinator.snapshot()[key], true);
    assert.equal(toggle.value(), false, "redo cannot execute paused sync");
    coordinator.select(key, false);
    assert.equal(stack.length, 2, "paused selection must have user command");
    undoHistory.undo();
    assert.equal(coordinator.snapshot()[key], true);
    assert.equal(toggle.value(), false);
    pause.release();
    assert.equal(toggle.value(), true);
    assert.equal(stack.length, 1);
    undoHistory.undo();
    assert.equal(coordinator.snapshot()[key], false);
    assert.equal(toggle.value(), false);
  }
  coordinator.resetWorkspace({ date: false, time: false, barWidth: true });
  stack.length = 0;
  date.setValue(true);
  assert.equal(coordinator.snapshot().date, false);
  assert.equal(date.value(), false);
  assert.equal(internalDate.value(), false);
  assert.equal(stack.length, 0, "disabled date creates no command");
  coordinator.resetWorkspace({ date: false, time: false });
  stack.length = 0;
  coordinator.select("time", true);
  coordinator.select("barWidth", true);
  undoHistory.undo();
  assert.equal(coordinator.snapshot().time, false);
  assert.equal(
    coordinator.snapshot().barWidth,
    true,
    "time undo preserves independent bar width mode",
  );
  undoHistory.redo();
  assert.equal(coordinator.snapshot().time, true);
  assert.equal(coordinator.snapshot().barWidth, true);
  coordinator.resetWorkspace({ date: false, time: false });
  stack.length = 0;
  coordinator.select("date", true);
  coordinator.configure({ ...coordinator.snapshot(), time: true });
  undoHistory.undo();
  assert.equal(coordinator.snapshot().date, false);
  assert.equal(
    coordinator.snapshot().time,
    true,
    "date undo preserves independent time choice",
  );
  undoHistory.redo();
  assert.equal(coordinator.snapshot().date, true);
  assert.equal(coordinator.snapshot().time, true);
  coordinator.resetWorkspace({ date: false, time: false });
  coordinator.select("time", true);
  coordinator.resetWorkspace({ date: false, time: false });
  undoHistory.undo();
  assert.equal(
    coordinator.snapshot().time,
    false,
    "old command cannot change a new workspace",
  );
  const saveStart = bundle.indexOf("_handleChartSaved(e){"),
    saveEnd = bundle.indexOf("}}", saveStart);
  let nativeDirty;
  const watcher = { _setContentHasChanges: (v) => (nativeDirty = v) };
  const handleSaved = vm
    .runInContext(
      `(function(e){${bundle.slice(saveStart + 21, saveEnd)}})`,
      context,
    )
    .bind(watcher);
  let hostDirty = true;
  context.MWNativeSave = { hasUnsavedChanges: () => hostDirty };
  handleSaved(true);
  assert.equal(nativeDirty, true, "A success must retain B Save state");
  hostDirty = false;
  handleSaved(true);
  assert.equal(nativeDirty, false, "B success clears native Save state");
  nativeDirty = true;
  handleSaved(false);
  assert.equal(nativeDirty, true, "save failure cannot clear native state");
  coordinator.dispose();
  console.log(
    "Native logical choices, paused Undo/Redo, disabled dates, old workspace and native Save cleanup: PASS",
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
