/* Mobile-only adapter for the pinned v31 saved layout. Keep each chart opaque:
 * copy its complete state, and change only the layout envelope and our metadata.
 * Desktop never projects or merges a document through this module. */
globalThis.MWMobileChartDocument = (() => {
  const clone = value => structuredClone(value);
  function charts(document) {
    if (!Array.isArray(document?.charts) || !document.charts.length ||
        document.charts.some(chart => chart?.version !== 3 || !Array.isArray(chart.panes)))
      throw Error('当前工作区图格格式不支持手机单图加载');
    return document.charts;
  }
  function main(chart) {
    const source = chart.panes.flatMap(pane => pane.sources || []).find(source => source.type === 'MainSeries');
    if (!source?.state?.symbol || !source.state.interval) throw Error('图格行情身份不完整');
    return source.state;
  }
  function directory(document) {
    return charts(document).map((chart, original_index) => {
      const source = main(chart);
      return {original_index, original_chart_id: document._mwAlertCharts?.[original_index] || null,
        symbol: source.symbol, resolution: source.interval};
    });
  }
  function project(document, index) {
    const rows = charts(document);
    if (!Number.isSafeInteger(index) || !rows[index]) throw Error('原图格不存在，请刷新工作区');
    const result = clone(document);
    result.charts = [clone(rows[index])];
    result.layout = 's';
    // Synchronization belongs to the original multi-chart workspace. Never
    // activate it in the mobile projection, or write its temporary values back.
    for (const key of ['symbolLock','intervalLock','trackTimeLock','dateRangeLock','crosshairLock']) result[key] = 0;
    result.layoutsSizes = document.layoutsSizes?.s ? {s:clone(document.layoutsSizes.s)} : {};
    result._mwSync = {date:false,time:false,barWidth:false};
    if (document._mwViewports) result._mwViewports = [clone(document._mwViewports[index])];
    if (document._mwAlertCharts) result._mwAlertCharts = [document._mwAlertCharts[index]];
    if (document._mwDrawingProjection) result._mwDrawingProjection = {
      ...clone(document._mwDrawingProjection), charts: document._mwDrawingProjection.charts
        .filter(row => row.chart_id === String(index)).map(row => ({...clone(row),chart_id:'0'})),
    };
    return result;
  }
  function merge(document, index, single) {
    const rows = charts(document), updated = charts(single);
    if (!Number.isSafeInteger(index) || !rows[index] || updated.length !== 1)
      throw Error('保存目标图格无效，请重新加载');
    const result = clone(document), chart = clone(updated[0]);
    // The original identity/linking group belong to the desktop workspace.
    chart.chartId = rows[index].chartId;
    chart.linkingGroup = clone(rows[index].linkingGroup);
    chart.shouldBeSavedEvenIfHidden = rows[index].shouldBeSavedEvenIfHidden;
    result.charts[index] = chart;
    result.studyMetaInfoMap = clone(document.studyMetaInfoMap || {});
    for (const [key, value] of Object.entries(single.studyMetaInfoMap || {})) {
      if (Object.hasOwn(result.studyMetaInfoMap, key) && JSON.stringify(result.studyMetaInfoMap[key]) !== JSON.stringify(value))
        throw Error('指标定义已变化，请重新加载工作区后保存');
      result.studyMetaInfoMap[key] = clone(value);
    }
    if (single._mwViewports?.[0]) {
      result._mwViewports = clone(document._mwViewports || []);
      result._mwViewports[index] = clone(single._mwViewports[0]);
    }
    if (single._mwDrawingProjection?.charts?.[0]) {
      const records = clone(document._mwDrawingProjection?.charts || []);
      const row = {...clone(single._mwDrawingProjection.charts[0]),chart_id:String(index)};
      result._mwDrawingProjection = {version:1,charts:[...records.filter(item => item.chart_id!==String(index)),row]
        .sort((a,b)=>Number(a.chart_id)-Number(b.chart_id))};
    }
    return result;
  }
  return {directory, project, merge};
})();
