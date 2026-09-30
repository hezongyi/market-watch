/* Extract presentation only from the public widget.save snapshot. */
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
