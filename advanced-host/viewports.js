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
  const coordinator = widget._mwSyncCoordinator;
  const desired = coordinator.snapshot();
  const viewports = captureChartViewports(widget);
  const pause = coordinator.acquirePause('capture-layout', desired.date && widget.chartsCount()>1
    ? ['date','time','barWidth'] : ['barWidth']);
  try {
    const state = await new Promise((resolve, reject) => {
      try { widget.save(resolve); } catch(error) { reject(error); }
    });
    return {...state, _mwViewports: viewports, _mwSync: desired};
  } finally {
    pause.release();
  }
}

function restoreChartSynchronization(widget, desired) {
  if (desired) widget._mwSyncCoordinator.configure(desired, true);
  widget._mwLegacyPause?.release();
  delete widget._mwLegacyPause;
}

function deferLegacyChartSynchronization(widget) {
  const coordinator = widget._mwSyncCoordinator;
  const desired = coordinator.snapshot();
  widget._mwLegacyPause?.release();
  if (desired.date && widget.chartsCount()>1)
    widget._mwLegacyPause = coordinator.acquirePause('legacy-load',['date','time','barWidth']);
  return desired;
}

function restoreHistoricalSpacing(chart, spacing) {
  const scale=chart.getTimeScale();
  const centerOffset=scale.rightOffset()-scale.width()/scale.barSpacing()/2;
  scale.setBarSpacing(spacing);
  scale.setRightOffset(centerOffset+scale.width()/spacing/2);
}
async function restoreChartViewports(widget, viewports, isCurrent, wait = promise => promise) {
  if (!Array.isArray(viewports) || !isCurrent()) return;
  const coordinator = widget._mwSyncCoordinator,
    desired = coordinator.snapshot().date;
  let pause = coordinator.acquirePause('restore-viewport',['barWidth']);
  const matches = (state, chart) => state &&
    state.symbol === chart.symbol() && state.resolution === chart.resolution() &&
    Number.isFinite(state.range?.from) && Number.isFinite(state.range?.to) &&
    state.range.to > state.range.from && state.spacing > 0 &&
    Number.isFinite(state.spacing) && Number.isFinite(state.offset);
  try {
    // Let the saved native synchronization finish loading its peers before
    // changing either toggle. Switching it off while a peer's initial range
    // call is pending can leave a rejected native deferred without a handler.
    await wait(Promise.all(Array.from({ length: widget.chartsCount() }, (_, index) =>
      new Promise(resolve => widget.chart(index).dataReady(resolve)))));
    await wait(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!isCurrent()) return;
    if (desired && widget.chartsCount() > 1 && viewports.length >= widget.chartsCount() &&
        viewports.slice(0, widget.chartsCount()).every((state, index) => matches(state, widget.chart(index)))) {
      // A date-synchronized layout has one range authority. Restore that
      // chart and let native synchronization move its peers; independent
      // per-pane mutations interrupt native pending range operations.
      const chart = widget.activeChart(), state = viewports[widget.activeChartIndex()];
      if (state.offset < 0) {
        await wait(chart.setVisibleRange(state.range, { rejectByTimeout: 30000 }));
        restoreHistoricalSpacing(chart,state.spacing);
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
    const allPause = coordinator.acquirePause('restore-independent-viewports',['date','time','barWidth']);
    pause.release();
    pause = allPause;
    for (
      let index = 0;
      index < Math.min(viewports.length, widget.chartsCount());
      index++
    ) {
      const state = viewports[index],
        chart = widget.chart(index);
      if (!matches(state, chart)) continue;
      await wait(new Promise((resolve) => chart.dataReady(resolve)));
      // Leave native data-ready dispatch before mutating its scale or sync state.
      await wait(new Promise((resolve) => setTimeout(resolve, 0)));
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
            await wait(chart.setVisibleRange(state.range, { rejectByTimeout: 30000 }));
            break;
          } catch(error) {
            if (error?.message !== 'Value is null' || attempt >= 20) throw error;
            await wait(new Promise(resolve=>setTimeout(resolve,100)));
          }
        }
      } else {
        // Native save stores the default margin. Restore the actual margin without changing preferences.
        const scale = chart.getTimeScale();
        scale.setBarSpacing(state.spacing);
        scale.setRightOffset(state.offset);
      }
      if (!isCurrent()) return;
      if (state.offset < 0) {
        // Native fitting rounds bar counts; preserve the saved width and center.
        restoreHistoricalSpacing(chart,state.spacing);
      }
    }
  } finally {
    pause.release();
  }
}

// Correct native range differences at data edges and historical session gaps.
function edgeRangeSync(widget, blocked, onError, prepare = async (_, target) => target, notice = () => {}) {
  const bindings = new Map();
  const coordinator = widget._mwSyncCoordinator;
  const reconciled = new Map();
  let timer, applying = false, disposed = false, generation = 0, activePause;
  let alignmentCount = 0, lastTarget, retryPending = false;
  const unsubscribe = coordinator.subscribe((state,event) => {
    if(event?.execution)return;
    generation++;
    reconciled.clear();
    if (!coordinator.snapshot().date) for (const peer of bindings.keys()) notice(peer, '');
  });
  async function align(chart) {
    timer = undefined;
    if (
      disposed ||
      applying ||
      !coordinator.snapshot().date ||
      widget.activeChart() !== chart
    )
      return;
    if (blocked()) {
      timer = setTimeout(() => align(widget.activeChart()), 150);
      return;
    }
    const target = chart.getVisibleRange();
    lastTarget = target;
    if (!(target?.to > target?.from)) return;
    const settled = peer => {
      const range = peer.getVisibleRange(), previous = reconciled.get(peer);
      // Capacity and session edges can legitimately clamp a public range.
      // Do not replay an unchanged correction on its late native notification.
      const boundary = globalThis.MWNativeNavigation?.rangeBoundary(peer);
      if (Number.isFinite(boundary) && target.from < boundary && range?.from === boundary)
        return true;
      return previous?.source === chart &&
        previous.target.from === target.from && previous.target.to === target.to &&
        previous.actual.from === range?.from && previous.actual.to === range?.to;
    };
    const peers = [...bindings.keys()].filter((peer) => {
      const minutes = Number(peer.resolution());
      return (
        peer !== chart &&
        !settled(peer) &&
        minutes > 0 &&
        Number.isFinite(minutes) &&
        peer.dataReady() &&
        (Math.abs(peer.getVisibleRange().to - target.to) > minutes * 60 ||
          Math.abs(peer.getVisibleRange().from - target.from) > minutes * 60)
      );
    });
    for (const peer of bindings.keys()) {
      if (!peers.includes(peer) && !settled(peer)) notice(peer, "");
    }
    if (!peers.length) return;
    const current = ++generation;
    retryPending = false;
    alignmentCount++;
    applying = true;
    const pause = activePause = coordinator.acquirePause('edge-alignment',['date','time','barWidth']);
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
          if (!disposed && current === generation) {
            const actual = peer.getVisibleRange();
            if (actual?.to > actual?.from)
              reconciled.set(peer, {source: chart, target: {...target}, actual: {...actual}});
            notice(peer, adjusted.notice || "");
          }
        } catch (error) {
          // The native engine owns capacity failure and asynchronously places
          // this pane at the real boundary; it is not a failed session lookup.
          if (!disposed && error?.code !== "NATIVE_HISTORY_CAPACITY_EXCEEDED") onError(error);
        }
      }));
    } finally {
      pause.release();
      if (activePause === pause) activePause = undefined;
      applying = false;
      // A wheel/drag can arrive while a peer's public range call is pending.
      // Reconcile the latest active viewport instead of dropping that intent.
      const latest = !disposed && widget.activeChart() === chart && chart.getVisibleRange();
      if (!disposed && coordinator.snapshot().date &&
          (retryPending || latest && (latest.from !== target.from || latest.to !== target.to))) {
        clearTimeout(timer);
        timer = setTimeout(() => align(widget.activeChart()), 150);
      }
    }
  }
  function refresh() {
    generation++;
    reconciled.clear();
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
        reconciled.clear();
      };
      chart.onSymbolChanged().subscribe(null, changed);
      chart.onIntervalChanged().subscribe(null, changed);
      const callback = () => {
        if (disposed || !coordinator.snapshot().date) return;
        if (applying) {
          if (widget.activeChart() === chart) retryPending = true;
          return;
        }
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
    retry() {
      generation++; reconciled.clear(); retryPending = true;
      if (!disposed && !applying && coordinator.snapshot().date) {
        clearTimeout(timer);
        timer = setTimeout(() => align(widget.activeChart()), 150);
      }
    },
    busy: () => applying || timer !== undefined,
    diagnostics: () => ({ applying, scheduled: timer !== undefined, blocked: blocked(), alignmentCount, lastTarget }),
    dispose() {
      disposed = true;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      activePause?.release();
      unsubscribe();
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
  let loaded, failed, timeout, expired = false, interacted = false;
  const seriesErrors = chart.onSeriesError?.();
  const interaction = () => { interacted = true; };
  const wheelDocuments = typeof document === 'undefined' ? [] : [document,
    ...Array.from(document.querySelectorAll('iframe'), frame => {
      try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
  for (const target of wheelDocuments) target.addEventListener('wheel', interaction, {capture:true,passive:true});
  widget.subscribe("mouse_down", interaction);
  widget.subscribe("activeChartChanged", interaction);
  widget.subscribe("layout_about_to_be_changed", interaction);
  const current = () => isCurrent() && !interacted && !expired &&
    index < widget.chartsCount() && widget.chart(index) === chart;
  // onDataLoaded can precede dataReady, including an unsuccessful empty load.
  // One budget must cover readiness and viewport restoration as well as reset.
  const budget = new Promise((_, reject) => {
    failed = error => reject(error instanceof Error ? error : Error(String(error || "历史读取失败")));
    timeout = setTimeout(() => {
      expired = true;
      reject(Error("历史刷新等待超时"));
    }, 15000);
  });
  seriesErrors?.subscribe(null, failed);
  const wait = promise => Promise.race([promise, budget]);
  const completion = new Promise(resolve => {
    loaded = () => resolve();
    chart.onDataLoaded().subscribe(null, loaded);
  });
  try {
    invalidate();
    chart.resetData();
    await wait(completion);
    // Native scale geometry settles on the render cycle after data dispatch.
    await wait(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!current()) return false;
    // Native reload can change spacing itself. Only actual user interaction
    // supersedes restoration; a numeric spacing difference is not evidence of it.
    await restoreChartViewports(widget, selected, current, wait);
    return current();
  } finally {
    for (const target of wheelDocuments) target.removeEventListener('wheel', interaction, true);
    widget.unsubscribe("mouse_down", interaction);
    widget.unsubscribe("activeChartChanged", interaction);
    widget.unsubscribe("layout_about_to_be_changed", interaction);
    clearTimeout(timeout);
    chart.onDataLoaded().unsubscribe(null, loaded);
    seriesErrors?.unsubscribe(null, failed);
  }
}
// Import old native layouts before loading can replace their watched values
// with temporary execution state. Modern host metadata remains authoritative.
function chartSynchronizationState(state) {
  if (!state) return undefined;
  if (state._mwSync) return state._mwSync;
  return {
    date: state.dateRangeLock === true || state.dateRangeLock === 1,
    time: state.trackTimeLock === true || state.trackTimeLock === 1,
    barWidth: false,
  };
}
