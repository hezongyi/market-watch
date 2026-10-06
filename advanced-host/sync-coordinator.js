/* User choices and effective execution state have one owner per widget. */
function chartSyncCoordinator(
  widget,
  {
    initial,
    changed = () => {},
    readonly = false,
    frame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
  } = {},
) {
  const listeners = new Set(),
    pauses = new Set(),
    bindings = new Map(),
    queue = new Map();
  let disposed = false,
    internal = false,
    epoch = 0,
    layoutEpoch = 0,
    operationId = 0,
    raf = 0,
    mode = "none",
    time = false,
    operation;
  const dateToggle = widget.dateRangeSync(),
    timeToggle = widget.timeSync(),
    collection = widget._innerAPI?.()._chartWidgetCollection;
  const snapshot = () => ({
    date: mode === "date",
    barWidth: mode === "barWidth",
    time,
  });
  const paused = (key) =>
    [...pauses].some((t) => t.epoch === epoch && t.mask.includes(key));
  const notify = (execution = false) =>
    listeners.forEach((fn) => fn(snapshot(), { execution }));
  function cancelOperation() {
    if (operation) operation.cancelled = true;
    operation = undefined;
    queue.clear();
    cancelFrame(raf);
    raf = 0;
  }
  function write(toggle, value, key) {
    const effective = collection?.[
      key === "date" ? "_internalDateRangeLock" : "_internalTrackTimeLock"
    ];
    if (toggle.value() === value && (!effective || effective.value() === value))
      return;
    internal = true;
    try {
      MWNativeSync.write(() => {
        if (effective && effective.value() !== value)
          collection[
            key === "date" ? "_handleDateRangeLockChange" : "_handleTrackTimeLockChange"
          ](value);
        toggle.setValue(value);
      });
    } finally {
      internal = false;
    }
  }
  function apply() {
    if (disposed) return;
    write(dateToggle, mode === "date" && !paused("date"), "date");
    write(timeToggle, time && !paused("time"), "time");
  }
  function configure(value, restore = false) {
    if (disposed) return;
    const before = JSON.stringify(snapshot());
    // Illegal legacy double-on states preserve date. Normal UI uses select().
    mode =
      value?.date === true
        ? "date"
        : value?.barWidth === true
          ? "barWidth"
          : "none";
    if (typeof value?.time === "boolean") time = value.time;
    cancelOperation();
    apply();
    if (JSON.stringify(snapshot()) !== before) {
      notify();
      if (!restore && !readonly) changed();
    }
  }
  function select(key, enabled) {
    if (collection && (key === "date" || key === "time")) {
      collection[
        key === "date" ? "_handleDateRangeLockChange" : "_handleTrackTimeLockChange"
      ](enabled);
      return snapshot()[key] === enabled;
    }
    if (key === "time") {
      configure({ ...snapshot(), time: enabled });
      return true;
    }
    const next = key === "date" ? "date" : "barWidth";
    if (enabled && mode !== "none" && mode !== next) return false;
    configure({
      ...snapshot(),
      date: enabled && next === "date",
      barWidth: enabled && next === "barWidth",
    });
    return true;
  }
  function acceptChoice(owner, key, enabled, label) {
    if (owner !== collection || owner._loadingContent || internal || disposed)
      return false;
    if (key === "date" && enabled && mode === "barWidth") {
      apply();
      return true;
    }
    const before = key === "time" ? time : mode,
      next = key === "time" ? enabled : enabled ? "date" : "none";
    if (before !== next) {
      // Native commands retain a logical snapshot, never a temporarily paused
      // internal watched value. Old-workspace commands cannot mutate a new one.
      const commandEpoch = epoch;
      collection.undoHistory.setWatchedValue({
        value: () => before,
        setValue: (value) => {
          if (disposed || commandEpoch !== epoch) return;
          configure(key === "time" ? { ...snapshot(), time: value } : {
            ...snapshot(), date: value === "date", barWidth: value === "barWidth",
          });
        },
      }, next, label);
    } else apply();
    return true;
  }
  function dateChanged(value) {
    if (internal || disposed) return;
    if (value && mode === "barWidth") {
      apply();
      return;
    }
    configure({ ...snapshot(), date: value });
  }
  function timeChanged(value) {
    if (!internal && !disposed) configure({ ...snapshot(), time: value });
  }
  function acquirePause(reason, mask = ["date", "time", "barWidth"]) {
    cancelOperation();
    const token = { reason, mask, epoch, released: false };
    pauses.add(token);
    apply();
    notify(true);
    return {
      release() {
        if (token.released) return;
        token.released = true;
        pauses.delete(token);
        if (!disposed && token.epoch === epoch) {
          apply();
          notify(true);
        }
      },
    };
  }
  const isTime = (c) => [0, 1, 2, 3, 9].includes(c.chartType());
  function valid(token) {
    return (
      token &&
      !disposed &&
      !token.cancelled &&
      token === operation &&
      mode === "barWidth" &&
      !paused("barWidth") &&
      token.epoch === epoch &&
      token.layoutEpoch === layoutEpoch &&
      bindings.has(token.chart)
    );
  }
  function flush() {
    raf = 0;
    const token = operation;
    const latest = queue.get(token);
    queue.clear();
    if (valid(token) && Number.isFinite(latest) && latest > 0) {
      for (const peer of bindings.keys()) {
        if (peer === token.chart || !isTime(peer) || !peer.dataReady())
          continue;
        const scale = peer.getTimeScale();
        if (Math.abs(scale.barSpacing() - latest) > 1e-6)
          scale.setBarSpacing(latest);
      }
    }
    if (token?.ended && operation === token) operation = undefined;
  }
  function begin(model, kind) {
    if (disposed || mode !== "barWidth" || paused("barWidth")) return;
    const chart = [...bindings.keys()].find(
      c => c._chartWidget.model().model() === model,
    );
    if (
      !chart ||
      !bindings.has(chart) ||
      !isTime(chart) ||
      chart._chartWidget.model().model() !== model
    )
      return;
    // At a verified native input entry, window.event is the synchronous trusted
    // dispatch; asynchronous animation steps keep this token in their closure.
    const input = chart._chartWidget.ownerDocument().defaultView.event;
    if (!input?.isTrusted) return;
    cancelOperation();
    return (operation = {
      chart,
      kind,
      epoch,
      layoutEpoch,
      id: ++operationId,
    });
  }
  function step(token, fn) {
    // Cancellation stops propagation, never the underlying native user action.
    const before = valid(token)
      ? token.chart.getTimeScale().barSpacing()
      : undefined;
    const result = fn();
    if (valid(token)) {
      const value = token.chart.getTimeScale().barSpacing();
      if (value !== before) {
        queue.set(token, value);
        if (!raf) raf = frame(flush);
      }
    }
    return result;
  }
  function end(token) {
    if (!valid(token)) return;
    token.ended = true;
    if (!raf) operation = undefined;
  }
  function refreshCharts() {
    layoutEpoch++;
    cancelOperation();
    const charts = new Set(
      Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i)),
    );
    for (const [chart, cleanup] of bindings)
      if (!charts.has(chart)) {
        cleanup();
        bindings.delete(chart);
      }
    for (const chart of charts)
      if (!bindings.has(chart)) {
        const invalidated = () => cancelOperation();
        chart.onSymbolChanged().subscribe(null, invalidated);
        chart.onIntervalChanged().subscribe(null, invalidated);
        bindings.set(chart, () => {
          chart.onSymbolChanged().unsubscribe(null, invalidated);
          chart.onIntervalChanged().unsubscribe(null, invalidated);
        });
      }
    apply();
  }
  function resetWorkspace(value) {
    epoch++;
    pauses.clear();
    cancelOperation();
    configure(value || { date: false, barWidth: false, time: false }, true);
    notify();
  }
  time = timeToggle.value();
  mode = dateToggle.value() ? "date" : "none";
  // In the licensed widget SHA-verified choice handlers own user commands.
  // Simple public-API hosts without that collection use watched-value input.
  if (!collection) {
    dateToggle.subscribe(dateChanged);
    timeToggle.subscribe(timeChanged);
  }
  widget.subscribe("layout_about_to_be_changed", cancelOperation);
  refreshCharts();
  if (initial) configure(initial, true);
  const api = {
    configure,
    select,
    acceptChoice,
    snapshot,
    acquirePause,
    refreshCharts,
    resetWorkspace,
    begin,
    step,
    end,
    epoch: () => epoch,
    invalidate: cancelOperation,
    internalWrite: () => internal,
    isPaused: paused,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    diagnostics: () => ({
      epoch,
      layoutEpoch,
      mode,
      time,
      pauses: pauses.size,
      bindings: bindings.size,
      queued: queue.size,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      cancelOperation();
      pauses.clear();
      if (!collection) {
        dateToggle.unsubscribe(dateChanged);
        timeToggle.unsubscribe(timeChanged);
      }
      widget.unsubscribe("layout_about_to_be_changed", cancelOperation);
      bindings.forEach((fn) => fn());
      bindings.clear();
      listeners.clear();
      if (widget._mwSyncCoordinator === api) delete widget._mwSyncCoordinator;
    },
  };
  widget._mwSyncCoordinator = api;
  return api;
}
// This narrow write scope is inspected by SHA-verified handlers. It never
// modifies vendor loading flags or clears user Undo/Redo history.
globalThis.MWNativeSync = (() => {
  let writeDepth = 0;
  return {
    write(fn) {
      writeDepth++;
      try {
        return fn();
      } finally {
        writeDepth--;
      }
    },
    internalWrite: () => writeDepth > 0,
    handleChoice: (...args) =>
      writeDepth === 0 && globalThis.MWSyncCoordinator?.acceptChoice(...args),
    railHeight: (cw) => globalThis.MWBarRangeMapping?.railHeight?.(cw) || 0,
    begin: (...args) => globalThis.MWSyncCoordinator?.begin(...args),
    step: (token, fn) =>
      globalThis.MWSyncCoordinator
        ? globalThis.MWSyncCoordinator.step(token, fn)
        : fn(),
    end: (token) => globalThis.MWSyncCoordinator?.end(token),
    run(model, kind, fn) {
      const token = this.begin(model, kind);
      try {
        return this.step(token, fn);
      } finally {
        this.end(token);
      }
    },
  };
})();
