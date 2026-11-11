/* Local settings only: no server preference revisions, drafts or cross-tab hints. */
function mobileChartPreferences(initial, rpc, report) {
  const settings = Object.fromEntries(initial.filter(row=>row.kind==='setting').map(row=>[row.name,row.content.value]));
  return {
    dispose() {},
    savePreference: (_kind,name,value) => rpc('save',{name,value}),
    templates: {},
    settings: {
      initialSettings: settings,
      setValue: (name,value) => {void rpc('save',{name,value}).catch(report);},
      removeValue: name => {void rpc('delete',{name}).catch(report);},
    },
  };
}

function mobileChartParameterEditing(container) {
  const doc=container.querySelector('iframe')?.contentDocument;
  return [...doc?.querySelectorAll('[data-name="indicator-properties-dialog"],[data-name="chart-properties-dialog"]') || []]
    .some(node=>!node.hidden && node.getBoundingClientRect().height>0);
}

/** Pinned v31 touch tracking, using its own crosshair and touch handling. */
function mobileChartCrosshair(widget, enabled) {
  if (!String(TradingView.version()).includes('6b804c486857f27920cf761aa7eb6e29d9bb6362'))
    throw Error('当前图表版本的触屏十字线尚未适配');
  const chart = widget.activeChart()._chartWidget;
  const panes = chart?.paneWidgets?.();
  if (!panes?.length) throw Error('十字线尚未就绪');
  if (!enabled) {
    for (const pane of panes) pane.exitTrackingMode();
    chart.model().model().clearCurrentPosition();
    return false;
  }
  const pane = panes[0];
  const point = chart.model().model().crosshairSource().currentPoint().clone();
  if (!Number.isFinite(point.x) || point.x < 0) point.x = pane.size().width / 2;
  if (!Number.isFinite(point.y) || point.y < 0) point.y = pane.size().height / 2;
  pane.startTrackingMode(point, point);
  return pane.trackingModeEnabled();
}
