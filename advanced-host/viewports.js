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
async function restoreChartViewports(widget, viewports, isCurrent) {
  if (!Array.isArray(viewports) || !isCurrent()) return;
  const sync = widget.dateRangeSync(),
    desired = sync.value();
  sync.setValue(false);
  try {
    for (
      let index = 0;
      index < Math.min(viewports.length, widget.chartsCount());
      index++
    ) {
      const state = viewports[index],
        chart = widget.chart(index);
      if (
        !state ||
        state.symbol !== chart.symbol() ||
        state.resolution !== chart.resolution() ||
        !Number.isFinite(state.range?.from) ||
        !Number.isFinite(state.range?.to) ||
        !(state.range.to > state.range.from) ||
        !(state.spacing > 0) ||
        !Number.isFinite(state.spacing) ||
        !Number.isFinite(state.offset)
      )
        continue;
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
        await chart.setVisibleRange(state.range, { rejectByTimeout: 30000 });
      } else {
        // Native save stores the default margin. Restore the actual margin without changing preferences.
        const scale = chart.getTimeScale();
        scale.setBarSpacing(state.spacing);
        scale.setRightOffset(state.offset);
      }
      if (!isCurrent()) return;
    }
  } finally {
    if (isCurrent()) sync.setValue(desired);
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
      blocked() ||
      !range.value() ||
      widget.activeChart() !== chart
    )
      return;
    const target = chart.getVisibleRange();
    if (!(target?.to > target?.from)) return;
    const peers = [...bindings.keys()].filter((peer) => {
      const minutes = Number(peer.resolution());
      return (
        peer !== chart &&
        minutes > 0 &&
        Number.isFinite(minutes) &&
        peer.dataReady() &&
        Math.abs(peer.getVisibleRange().to - target.to) > minutes * 60
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
      for (const peer of peers) {
        if (disposed || current !== generation || blocked()) break;
        try {
          const adjusted = await prepare(peer, target);
          if (disposed || current !== generation || blocked()) break;
          await peer.setVisibleRange({from: adjusted.from, to: adjusted.to}, { rejectByTimeout: 20000 });
          if (!disposed && current === generation) notice(peer, adjusted.notice || "");
        } catch (error) {
          if (!disposed) onError(error);
        }
      }
    } finally {
      if (!disposed) restore();
      applying = false;
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
        if (disposed || applying || blocked() || !range.value()) return;
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
    // Wheel zoom changes spacing without mouse_down. Native history insertion
    // retains spacing; a changed spacing belongs to a newer user intention.
    if (chart.getTimeScale().barSpacing() !== state[index].spacing) return false;
    await restoreChartViewports(widget, selected, current);
    return current();
  } finally {
    widget.unsubscribe("mouse_down", interaction);
    widget.unsubscribe("activeChartChanged", interaction);
    widget.unsubscribe("layout_about_to_be_changed", interaction);
    clearTimeout(timeout);
    chart.onDataLoaded().unsubscribe(null, loaded);
  }
}
