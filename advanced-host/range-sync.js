/* Public chart APIs only. The caller refreshes bindings after layout changes. */
function rangeSyncLoadingGuard(widget, onIntervalChange = () => {}) {
  const toggle = widget.dateRangeSync();
  const bindings = new Map();
  const pending = new Map();
  let desired = toggle.value(),
    internal = false,
    disposed = false;
  function set(value) {
    internal = true;
    try {
      toggle.setValue(value);
    } finally {
      internal = false;
    }
  }
  function restore() {
    if (!disposed && !pending.size) set(desired);
  }
  function changed(value) {
    if (internal || disposed) return;
    desired = value;
    if (pending.size && value) set(false);
  }
  toggle.subscribe(changed);
  function refresh() {
    if (disposed) return;
    const charts = new Set(
      Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i)),
    );
    for (const [chart, callback] of bindings) {
      if (charts.has(chart)) continue;
      chart.onSymbolChanged().unsubscribe(null, callback);
      chart.onIntervalChanged().unsubscribe(null, callback);
      bindings.delete(chart);
      pending.delete(chart);
    }
    for (const chart of charts) {
      if (bindings.has(chart)) continue;
      const callback = (interval, parameters) => {
        if (typeof interval === "string")
          onIntervalChange(chart, interval, parameters);
        const token = {};
        pending.set(chart, token);
        if (toggle.value()) set(false);
        chart.dataReady(() => {
          if (disposed || pending.get(chart) !== token) return;
          pending.delete(chart);
          restore();
        });
      };
      bindings.set(chart, callback);
      chart.onSymbolChanged().subscribe(null, callback);
      chart.onIntervalChanged().subscribe(null, callback);
    }
    restore();
  }
  refresh();
  return {
    refresh,
    busy: () => pending.size > 0,
    desired: () => desired,
    dispose() {
      disposed = true;
      toggle.unsubscribe(changed);
      for (const [chart, callback] of bindings) {
        chart.onSymbolChanged().unsubscribe(null, callback);
        chart.onIntervalChanged().unsubscribe(null, callback);
      }
      bindings.clear();
      pending.clear();
    },
  };
}
