/* Viewport intent is independent of getBars' native paging/countBack requests. */
function chartDemandReporter(widget, client, submit, onError, clock = () => Date.now()) {
  const sent = new Map();
  const inFlight = new Set();
  const ids = new WeakMap();
  let sequence = 0, disposed = false, debounce;
  const bindings = new Map();
  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => reporter.tick(), 250);
  };
  const frames = {1:'M1',5:'M5',15:'M15',30:'M30',60:'H1',240:'H4','1D':'D1'};
  const reporter = {
    async tick() {
      if (disposed) return;
      const charts = new Set(Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)));
      for (const [chart, events] of bindings) {
        if (!charts.has(chart)) {
          for (const event of events) event.unsubscribe(null, changed);
          bindings.delete(chart);
        }
      }
      for (const chart of charts) {
        if (bindings.has(chart)) continue;
        const events = [chart.onIntervalChanged?.(), chart.onSymbolChanged?.(),
          chart.onVisibleRangeChanged?.()].filter(Boolean);
        for (const event of events) event.subscribe(null, changed);
        bindings.set(chart, events);
      }
      const work = [];
      for (let i = 0; i < widget.chartsCount(); i++) {
        const chart = widget.chart(i), timeframe = frames[chart.resolution()];
        if (!timeframe || chart.symbol().startsWith('MWPY_')) continue;
        if (!ids.has(chart)) ids.set(chart, `${client}:${++sequence}`);
        const id = ids.get(chart);
        if (inFlight.has(id)) continue;
        const scale = chart.getTimeScale();
        const spacing = scale.barSpacing(), width = scale.width();
        if (!(spacing > 0) || !(width > 0)) continue;
        const visible = Math.min(2000, Math.max(1, Math.ceil(width / spacing)));
        const range = chart.getVisibleRange();
        const now = clock();
        // Future whitespace must not make a historical window request future data.
        const end = Math.min(now, range?.to > 0 ? Math.ceil(range.to * 1000) : now);
        const args = {id,instrument:chart.symbol(),timeframe,end,visible,
          focused:chart === widget.activeChart()};
        const signature = JSON.stringify({...args,end:Math.floor(end / 60000)});
        const old = sent.get(id);
        if (old?.signature === signature && now - old.at < 15000) continue;
        inFlight.add(id);
        work.push(Promise.resolve().then(()=>submit(args)).then(()=> {
          if (!disposed) sent.set(id,{signature,at:now});
        }).catch(onError).finally(()=>inFlight.delete(id)));
      }
      await Promise.all(work);
    },
    dispose() {
      disposed = true; sent.clear(); clearTimeout(debounce);
      for (const events of bindings.values())
        for (const event of events) event.unsubscribe(null, changed);
      bindings.clear();
    },
  };
  return reporter;
}
