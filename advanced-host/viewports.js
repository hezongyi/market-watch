/* Workspace-only viewport state, using public chart APIs. Vendor layout is opaque. */
function captureChartViewports(widget) {
  return Array.from({ length: widget.chartsCount() }, (_, index) => {
    const chart = widget.chart(index),
      scale = chart.getTimeScale();
    return {
      symbol: chart.symbol(),
      resolution: chart.resolution(),
      range: chart.getVisibleRange(),
      spacing: scale.barSpacing(),
      offset: scale.rightOffset(),
      width: scale.width(),
    };
  });
}
const chartSnapshotQueues = new WeakMap();
function captureChartLayout(widget) {
  const pending = (chartSnapshotQueues.get(widget) || Promise.resolve()).catch(() => {})
    .then(() => captureChartLayoutNow(widget));
  chartSnapshotQueues.set(widget, pending);
  const clear = () => { if (chartSnapshotQueues.get(widget) === pending) chartSnapshotQueues.delete(widget); };
  pending.then(clear, clear);
  return pending;
}
async function captureChartLayoutNow(widget) {
  const date = widget.dateRangeSync(), time = widget.timeSync();
  const desired = {date: date.value(), time: time.value()};
  const viewports = captureChartViewports(widget);
  // Native startup synchronization can enqueue range jumps before peer tick
  // marks exist. Capture a layout through the public API with sync deferred;
  // store the user's choices in our own metadata and restore them after data.
  if (desired.date && widget.chartsCount() > 1) {
    date.setValue(false);
    time.setValue(false);
  }
  try {
    const state = await new Promise((resolve, reject) => {
      try { widget.save(resolve); } catch(error) { reject(error); }
    });
    return {...state, _mwViewports: viewports, _mwSync: desired};
  } finally {
    if (time.value() !== desired.time) time.setValue(desired.time);
    if (date.value() !== desired.date) date.setValue(desired.date);
  }
}

function restoreChartSynchronization(widget, desired) {
  if (typeof desired?.time === 'boolean' && widget.timeSync().value() !== desired.time)
    widget.timeSync().setValue(desired.time);
  if (typeof desired?.date === 'boolean' && widget.dateRangeSync().value() !== desired.date)
    widget.dateRangeSync().setValue(desired.date);
}

function deferLegacyChartSynchronization(widget) {
  const date = widget.dateRangeSync(), time = widget.timeSync();
  const desired = {date: date.value(), time: time.value()};
  // The first getBars call is early enough to avoid native startup range
  // propagation and late enough for these public watched values to exist.
  // Older opaque layouts cannot be rewritten into our new snapshot format.
  if (desired.date && widget.chartsCount() > 1) {
    date.setValue(false);
    time.setValue(false);
  }
  return desired;
}

async function restoreChartViewports(widget, viewports, isCurrent) {
  if (!Array.isArray(viewports) || !isCurrent()) return;
  const sync = widget.dateRangeSync(),
    desired = sync.value(),
    timeSync = widget.timeSync(),
    desiredTime = timeSync.value();
  const matches = (state, chart) => state &&
    state.symbol === chart.symbol() && state.resolution === chart.resolution() &&
    Number.isFinite(state.range?.from) && Number.isFinite(state.range?.to) &&
    state.range.to > state.range.from && state.spacing > 0 &&
    Number.isFinite(state.spacing) && Number.isFinite(state.offset);
  try {
    // Let the saved native synchronization finish loading its peers before
    // changing either toggle. Switching it off while a peer's initial range
    // call is pending can leave a rejected native deferred without a handler.
    await Promise.all(Array.from({ length: widget.chartsCount() }, (_, index) =>
      new Promise(resolve => widget.chart(index).dataReady(resolve))));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!isCurrent()) return;
    if (desired && widget.chartsCount() > 1 && viewports.length >= widget.chartsCount() &&
        viewports.slice(0, widget.chartsCount()).every((state, index) => matches(state, widget.chart(index)))) {
      // A date-synchronized layout has one range authority. Restore that
      // chart and let native synchronization move its peers; independent
      // per-pane mutations interrupt native pending range operations.
      const chart = widget.activeChart(), state = viewports[widget.activeChartIndex()];
      if (state.offset < 0) {
        await chart.setVisibleRange(state.range, { rejectByTimeout: 30000 });
      } else {
        // A latest viewport is geometry relative to the current last bar.
        // Converting its future margin to dates needlessly starts native
        // gotoTimeRange operations on every synchronized peer during reopen.
        const scale = chart.getTimeScale();
        if (Math.abs(scale.barSpacing() - state.spacing) > 1e-6) scale.setBarSpacing(state.spacing);
        if (Math.abs(scale.rightOffset() - state.offset) > 1e-6) scale.setRightOffset(state.offset);
      }
      return;
    }
    timeSync.setValue(false);
    sync.setValue(false);
    for (
      let index = 0;
      index < Math.min(viewports.length, widget.chartsCount());
      index++
    ) {
      const state = viewports[index],
        chart = widget.chart(index);
      if (!matches(state, chart)) continue;
      await new Promise((resolve) => chart.dataReady(resolve));
      // Leave native data-ready dispatch before mutating its scale or sync state.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!isCurrent()) return;
      if (
        state.symbol !== chart.symbol() ||
        state.resolution !== chart.resolution()
      )
        continue;
      if (state.offset < 0) {
        // Historical positions need actual dates; the latest data can advance between visits.
        chart.getTimeScale().setRightOffset(0);
        // resetData can emit data-ready before the native series metadata is
        // reattached. Retry only that observed transient public-API failure.
        for (let attempt=0;;attempt++) {
          if (!isCurrent()) return;
          try {
            await chart.setVisibleRange(state.range, { rejectByTimeout: 30000 });
            break;
          } catch(error) {
            if (error?.message !== 'Value is null' || attempt >= 20) throw error;
            await new Promise(resolve=>setTimeout(resolve,100));
          }
        }
      } else {
        // Native save stores the default margin. Restore the actual margin without changing preferences.
        const scale = chart.getTimeScale();
        scale.setBarSpacing(state.spacing);
        scale.setRightOffset(state.offset);
      }
      if (!isCurrent()) return;
    }
  } finally {
    if (isCurrent()) {
      if (timeSync.value() !== desiredTime) timeSync.setValue(desiredTime);
      if (sync.value() !== desired) sync.setValue(desired);
    }
  }
}

// Correct native range differences at data edges and historical session gaps.
function edgeRangeSync(widget, blocked, onError, prepare = async (_, target) => target, notice = () => {}) {
  const bindings = new Map();
  const range = widget.dateRangeSync(),
    time = widget.timeSync();
  let timer,
    applying = false,
    disposed = false,
    internal = false;
  let desiredRange = range.value(),
    desiredTime = time.value(),
    generation = 0;
  function set(toggle, value) {
    if (toggle.value() === value) return;
    internal = true;
    try {
      toggle.setValue(value);
    } finally {
      internal = false;
    }
  }
  function rangeChanged(value) {
    if (internal) return;
    desiredRange = value;
    if (!value) for (const peer of bindings.keys()) notice(peer, "");
    generation++;
  }
  function timeChanged(value) {
    if (internal) return;
    desiredTime = value;
    generation++;
  }
  range.subscribe(rangeChanged);
  time.subscribe(timeChanged);
  function restore() {
    set(range, desiredRange);
    set(time, desiredTime);
  }
  async function align(chart) {
    timer = undefined;
    if (
      disposed ||
      applying ||
      !range.value() ||
      widget.activeChart() !== chart
    )
      return;
    if (blocked()) {
      timer = setTimeout(() => align(widget.activeChart()), 150);
      return;
    }
    const target = chart.getVisibleRange();
    if (!(target?.to > target?.from)) return;
    const peers = [...bindings.keys()].filter((peer) => {
      const minutes = Number(peer.resolution());
      return (
        peer !== chart &&
        minutes > 0 &&
        Number.isFinite(minutes) &&
        peer.dataReady() &&
        (Math.abs(peer.getVisibleRange().to - target.to) > minutes * 60 ||
          Math.abs(peer.getVisibleRange().from - target.from) > minutes * 60)
      );
    });
    for (const peer of bindings.keys()) {
      if (!peers.includes(peer)) notice(peer, "");
    }
    if (!peers.length) return;
    const current = ++generation;
    applying = true;
    desiredRange = range.value();
    desiredTime = time.value();
    set(range, false);
    set(time, false);
    try {
      // Start independent session lookups together; settle errors immediately
      // so cancellation cannot leave an unhandled rejected lookup behind.
      const prepared = peers.map(peer => Promise.resolve().then(() => prepare(peer, target))
        .then(value => ({value}), error => ({error})));
      await Promise.all(peers.map(async (peer,index) => {
        if (disposed || current !== generation || blocked()) return;
        try {
          const result = await prepared[index];
          if (result.error) throw result.error;
          const adjusted = result.value;
          if (disposed || current !== generation || blocked()) return;
          await peer.setVisibleRange({from: adjusted.from, to: adjusted.to}, { rejectByTimeout: 20000 });
          if (!disposed && current === generation) notice(peer, adjusted.notice || "");
        } catch (error) {
          if (!disposed) onError(error);
        }
      }));
    } finally {
      if (!disposed) restore();
      applying = false;
      // A wheel/drag can arrive while a peer's public range call is pending.
      // Reconcile the latest active viewport instead of dropping that intent.
      const latest = !disposed && widget.activeChart() === chart && chart.getVisibleRange();
      if (!disposed && desiredRange && latest &&
          (latest.from !== target.from || latest.to !== target.to)) {
        clearTimeout(timer);
        timer = setTimeout(() => align(widget.activeChart()), 150);
      }
    }
  }
  function refresh() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    for (const [chart, binding] of bindings) {
      notice(chart, "");
      chart.onVisibleRangeChanged().unsubscribe(null, binding.callback);
      chart.onSymbolChanged().unsubscribe(null, binding.changed);
      chart.onIntervalChanged().unsubscribe(null, binding.changed);
    }
    bindings.clear();
    if (disposed) return;
    for (let i = 0; i < widget.chartsCount(); i++) {
      const chart = widget.chart(i);
      const changed = () => {
        notice(chart, "");
        generation++;
      };
      chart.onSymbolChanged().subscribe(null, changed);
      chart.onIntervalChanged().subscribe(null, changed);
      const callback = () => {
        if (disposed || applying || !range.value()) return;
        clearTimeout(timer);
        timer = setTimeout(() => align(widget.activeChart()), 150);
      };
      bindings.set(chart, { callback, changed });
      chart.onVisibleRangeChanged().subscribe(null, callback);
    }
  }
  refresh();
  return {
    refresh,
    busy: () => applying || timer !== undefined,
    dispose() {
      disposed = true;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      if (applying) restore();
      range.unsubscribe(rangeChanged);
      time.unsubscribe(timeChanged);
      for (const [chart, binding] of bindings) {
        chart.onVisibleRangeChanged().unsubscribe(null, binding.callback);
        chart.onSymbolChanged().unsubscribe(null, binding.changed);
        chart.onIntervalChanged().unsubscribe(null, binding.changed);
      }
      bindings.clear();
    },
  };
}

// Reset one series only after capturing its viewport. dataReady() may still
// describe the old series immediately after resetData(); wait for onDataLoaded.
// The caller invalidates the datafeed cache and owns cancellation on user input.
async function refreshChartHistory(widget, chart, invalidate, isCurrent) {
  if (!isCurrent()) return false;
  const state = captureChartViewports(widget);
  const index = Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i)).indexOf(chart);
  if (index < 0) return false;
  const selected = state.map((value, i) => i === index ? value : null);
  let loaded, timeout, interacted = false;
  const interaction = () => { interacted = true; };
  const wheelDocuments = typeof document === 'undefined' ? [] : [document,
    ...Array.from(document.querySelectorAll('iframe'), frame => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
  for (const target of wheelDocuments) target.addEventListener('wheel', interaction, {capture:true,passive:true});
  widget.subscribe("mouse_down", interaction);
  widget.subscribe("activeChartChanged", interaction);
  widget.subscribe("layout_about_to_be_changed", interaction);
  const current = () => isCurrent() && !interacted &&
    index < widget.chartsCount() && widget.chart(index) === chart;
  const completion = new Promise((resolve, reject) => {
    loaded = () => resolve();
    chart.onDataLoaded().subscribe(null, loaded);
    timeout = setTimeout(() => reject(Error("历史刷新等待超时")), 15000);
  });
  try {
    invalidate();
    chart.resetData();
    await completion;
    // Native scale geometry settles on the render cycle after data dispatch.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!current()) return false;
    // Native reload can change spacing itself. Only actual user interaction
    // supersedes restoration; a numeric spacing difference is not evidence of it.
    await restoreChartViewports(widget, selected, current);
    return current();
  } finally {
    for (const target of wheelDocuments) target.removeEventListener('wheel', interaction, true);
    widget.unsubscribe("mouse_down", interaction);
    widget.unsubscribe("activeChartChanged", interaction);
    widget.unsubscribe("layout_about_to_be_changed", interaction);
    clearTimeout(timeout);
    chart.onDataLoaded().unsubscribe(null, loaded);
  }
}
