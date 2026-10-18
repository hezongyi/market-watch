/* The active pane owns the tab. Quotes use the existing logical subscriptions. */
function chartTab({ widget, feed, send, workspace, epoch, metadata }) {
  const subscription = "mw-active-tab";
  let generation = 0,
    disposed = false,
    active,
    ticker,
    bindingEpoch;
  const bindings = new Map();
  function bind() {
    if (disposed) return;
    for (const [chart, changed] of bindings)
      chart.onSymbolChanged().unsubscribe(null, changed);
    bindings.clear();
    for (let i = 0; i < widget.chartsCount(); i++) {
      const chart = widget.chart(i),
        changed = () => select();
      chart.onSymbolChanged().subscribe(null, changed);
      bindings.set(chart, changed);
    }
    select();
  }
  function select(force = false) {
    if (disposed) return;
    const chart = widget.activeChart(),
      symbol = chart.symbol();
    if (
      !symbol ||
      (!force &&
        chart === active &&
        symbol === ticker &&
        epoch() === bindingEpoch)
    )
      return;
    active = chart;
    ticker = symbol;
    bindingEpoch = epoch();
    const ticket = ++generation,
      capturedEpoch = bindingEpoch,
      workspaceId = workspace()?.id;
    feed.unsubscribeQuotes(subscription);
    const info = chart.symbolExt?.() || {},
      meta = metadata(symbol);
    const label = meta?.display_symbol || meta?.symbol || info.name || symbol;
    // A comparison can switch the pane to a percentage/indexed price scale.
    // Format raw quotes with symbol precision, independently of that scale.
    const customFormatter = chartPriceFormatter(info, "default");
    const precision = Number.isInteger(meta?.precision)
      ? meta.precision
      : Math.log10(info.pricescale);
    const priceFormatter =
      customFormatter ||
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits:
          Number.isInteger(precision) && precision >= 0 && precision <= 12
            ? precision
            : 2,
        maximumFractionDigits:
          Number.isInteger(precision) && precision >= 0 && precision <= 12
            ? precision
            : 2,
      });
    const current = () =>
      !disposed &&
      generation === ticket &&
      epoch() === capturedEpoch &&
      workspace()?.id === workspaceId &&
      widget.activeChart() === chart &&
      chart.symbol() === symbol;
    const publish = (quote) => {
      if (!current()) return;
      const value = quote?.v,
        price = value?.lp;
      let formatted;
      if (Number.isFinite(price)) {
        try {
          formatted = priceFormatter.format(price);
        } catch {
          formatted = String(price);
        }
      }
      send({
        type: "active-quote",
        workspace_id: workspaceId,
        generation: ticket,
        ticker: symbol,
        label: value?.short_name || label,
        price,
        formatted,
        change: value?.chp,
        historical: MWSeries.decode(symbol).series_kind === "history",
        delayed:
          value?.delay_seconds > 0 ||
          (value?.fetch_status && value.fetch_status !== "ok"),
      });
    };
    publish(null);
    feed.subscribeQuotes(
      [],
      [symbol],
      (rows) => publish(rows.find((row) => row.n === symbol)),
      subscription,
    );
  }
  const selected = () => select();
  widget.subscribe("activeChartChanged", selected);
  widget.subscribe("layout_changed", bind);
  widget.subscribe("chart_loaded", bind);
  bind();
  return {
    refresh: bind,
    dispose() {
      disposed = true;
      generation++;
      feed.unsubscribeQuotes(subscription);
      for (const [chart, changed] of bindings)
        chart.onSymbolChanged().unsubscribe(null, changed);
      bindings.clear();
      widget.unsubscribe("activeChartChanged", selected);
      widget.unsubscribe("layout_changed", bind);
      widget.unsubscribe("chart_loaded", bind);
    },
  };
}
