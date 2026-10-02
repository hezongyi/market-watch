/* Extract presentation only from the public widget.save snapshot. */
// Grid line styles are public overrides but are excluded from native layout
// serialization. Store this choice separately so both styles survive reloads.
function chartGridPresentation(widget, initial, save, readonly, saved) {
  const preferred = initial.find(row => row.kind === "setting" && row.name === "mw.gridStyle")?.content.value;
  let value = ["solid", "dotted"].includes(saved) ? saved : preferred === "solid" ? "solid" : "dotted";
  let preview;
  const listeners = new Set();
  const apply = () => {
    const dotted = (preview || value) === "dotted";
    const dark = widget.getTheme().toLowerCase() === "dark";
    const color = dark
      ? `rgba(242, 242, 242, ${dotted ? 0.18 : 0.06})`
      : `rgba(42, 46, 57, ${dotted ? 0.18 : 0.06})`;
    widget.applyOverrides({
      // This installed renderer accepts sparse dotted (4): 1px dot, 4px gap.
      "paneProperties.vertGridProperties.style": dotted ? 4 : 0,
      "paneProperties.horzGridProperties.style": dotted ? 4 : 0,
      "paneProperties.vertGridProperties.color": color,
      "paneProperties.horzGridProperties.color": color,
    });
    for (const changed of listeners) changed(preview || value);
  };
  widget.subscribe("chart_theme_changed", apply);
  widget.subscribe("chart_loaded", apply);
  widget.subscribe("layout_changed", apply);
  apply();
  return {
    get value() { return value; },
    get displayValue() { return preview || value; },
    subscribe(changed) { listeners.add(changed); },
    beginPreview() { preview = value; },
    applyTemplate(next) {
      if (preview !== undefined) { this.preview(next); return Promise.resolve(); }
      return this.select(next);
    },
    readonly,
    restore(next) {
      if (!["dotted", "solid"].includes(next)) return;
      value = next;
      preview = undefined;
      apply();
    },
    preview(next) {
      preview = !readonly && ["dotted", "solid"].includes(next) ? next : undefined;
      apply();
    },
    async select(next) {
      if (readonly || !["dotted", "solid"].includes(next)) return;
      await save(next);
      value = next;
      preview = undefined;
      apply();
    },
  };
}

function chartStyleTemplate(state, index, gridStyle) {
  const chart = state?.charts?.[index];
  const main = chart?.panes
    ?.flatMap((pane) => pane.sources || [])
    .find((source) => source.type === "MainSeries")?.state;
  if (!chart?.chartProperties || !main) throw Error("图表样式尚未就绪");
  const allowed = new Set([
    "style",
    "showCountdown",
    "showPriceLine",
    "priceLineWidth",
    "showPrevClosePriceLine",
    "prevClosePriceLineWidth",
    "baseLineColor",
    "prevClosePriceLineColor",
    "priceLineColor",
    "statusViewStyle",
    "lineStyle",
    "lineWithMarkersStyle",
    "steplineStyle",
    "baselineStyle",
    "areaStyle",
    "hlcAreaStyle",
    "barStyle",
    "hlcBarsStyle",
    "candleStyle",
    "volCandlesStyle",
    "hollowCandleStyle",
    "haStyle",
    "hiloStyle",
    "columnStyle",
    "renkoStyle",
    "pbStyle",
    "kagiStyle",
    "pnfStyle",
    "rangeStyle",
  ]);
  return JSON.parse(
    JSON.stringify({
      version: chart.version,
      ...(["dotted", "solid"].includes(gridStyle) ? {_mwGridStyle: gridStyle} : {}),
      chartProperties: {
        paneProperties: chart.chartProperties.paneProperties,
        scalesProperties: chart.chartProperties.scalesProperties,
      },
      mainSourceProperties: Object.fromEntries(
        Object.entries(main).filter(([key]) => allowed.has(key)),
      ),
    }),
  );
}
