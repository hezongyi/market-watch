/* Public chart APIs only. The caller refreshes bindings after layout changes. */
function rangeSyncLoadingGuard(widget, onIntervalChange = () => {}) {
  const toggle = widget.dateRangeSync();
  const bindings = new Map();
  const pending = new Map();
  let desired = toggle.value(),
    internal = false,
    disposed = false;
  function set(value) {
    // The native setter records an undo action even for an unchanged value.
    if (toggle.value() === value) return;
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
    if (pending.size && value && widget.chartsCount() > 1) set(false);
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
        if (toggle.value() && widget.chartsCount() > 1) set(false);
        const finish = () => {
          if (disposed || pending.get(chart) !== token) return;
          pending.delete(chart);
          clearTimeout(token.timer);
          restore();
        };
        chart.dataReady(finish);
        // The native library does not emit dataReady for an explicit empty
        // boundary. Do not let that boundary lock synchronization forever;
        // a later period switch must remain usable.
        token.timer = setTimeout(finish, 2500);
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
