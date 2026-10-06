/* The coordinator owns choices; this guard owns only data-ready identities. */
function rangeSyncLoadingGuard(widget, onIntervalChange = () => {}) {
  const coordinator = widget._mwSyncCoordinator;
  const bindings = new Map(), pending = new Map();
  let disposed = false;
  function refresh() {
    if (disposed) return;
    const charts = new Set(Array.from({length: widget.chartsCount()}, (_,i)=>widget.chart(i)));
    for (const [chart, callback] of bindings) {
      if (charts.has(chart)) continue;
      chart.onSymbolChanged().unsubscribe(null, callback);
      chart.onIntervalChanged().unsubscribe(null, callback);
      bindings.delete(chart);
      pending.get(chart)?.pause.release();
      pending.delete(chart);
    }
    for (const chart of charts) {
      if (bindings.has(chart)) continue;
      const callback = (interval, parameters) => {
        if (typeof interval === 'string') onIntervalChange(chart,interval,parameters);
        const pause = coordinator.acquirePause('data-loading',widget.chartsCount()>1 ? ['date','barWidth'] : ['barWidth']);
        const previous = pending.get(chart);
        const token = {pause};
        pending.set(chart,token);
        previous?.pause.release();
        token.finish = () => {
          if (disposed || pending.get(chart) !== token) return;
          pending.delete(chart);
          pause.release();
        };
        chart.dataReady(token.finish);
      };
      bindings.set(chart,callback);
      chart.onSymbolChanged().subscribe(null,callback);
      chart.onIntervalChanged().subscribe(null,callback);
    }
  }
  refresh();
  return {
    refresh,
    captureTerminalCompletion(matches) {
      const loads = [...pending].filter(([chart])=>matches(chart));
      return () => loads.forEach(([chart,token])=>{
        if (!disposed && pending.get(chart)===token) token.finish();
      });
    },
    busy: () => pending.size > 0,
    desired: () => coordinator.snapshot().date,
    dispose() {
      disposed = true;
      for (const [chart,callback] of bindings) {
        chart.onSymbolChanged().unsubscribe(null,callback);
        chart.onIntervalChanged().unsubscribe(null,callback);
      }
      pending.forEach(token=>token.pause.release());
      bindings.clear(); pending.clear();
    },
  };
}
