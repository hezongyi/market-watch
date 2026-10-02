/* Extract presentation only from the public widget.save snapshot. */
// Grid line styles are public overrides but are excluded from native layout
// serialization. Store this choice separately so both styles survive reloads.
function chartGridPresentation(widget, initial, save, readonly) {
  const preferred = initial.find(row => row.kind === "setting" && row.name === "mw.gridStyle")?.content.value;
  let value = preferred === "solid" ? "solid" : "dotted";
  const apply = () => {
    const dotted = value === "dotted";
    const dark = widget.getTheme().toLowerCase() === "dark";
    const color = dark
      ? `rgba(242, 242, 242, ${dotted ? 0.18 : 0.06})`
      : `rgba(42, 46, 57, ${dotted ? 0.18 : 0.06})`;
    widget.applyOverrides({
      "paneProperties.vertGridProperties.style": dotted ? 1 : 0,
      "paneProperties.horzGridProperties.style": dotted ? 1 : 0,
      "paneProperties.vertGridProperties.color": color,
      "paneProperties.horzGridProperties.color": color,
    });
  };
  widget.subscribe("chart_theme_changed", apply);
  widget.subscribe("chart_loaded", apply);
  widget.subscribe("layout_changed", apply);
  apply();
  return {
    get value() { return value; },
    readonly,
    async select(next) {
      if (readonly || !["dotted", "solid"].includes(next) || next === value) return;
      await save(next);
      value = next;
      apply();
    },
  };
}

function chartStyleTemplate(state, index) {
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
