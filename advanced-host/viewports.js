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
