/* Public native chart APIs only. Coordinates are price/time, never screen pixels. */
function captureDrawingProjection(widget) {
  const charts = [];
  for (let i = 0; i < widget.chartsCount(); i++) {
    const chart = widget.chart(i);
    const record = { chart_id: String(i), symbol: chart.symbol(), resolution: chart.resolution(),
      drawings: [], status: "supported" };
    try {
      for (const shape of chart.getAllShapes()) {
        const item = { id: String(shape.id), name: shape.name, points: [] };
        try {
          const drawing = chart.getShapeById(shape.id);
          if (drawing.isSavingEnabled() === false) continue;
          item.points = drawing.getPoints().map(point => ({
            time: typeof point.time === "number" && Number.isFinite(point.time) ? point.time : null,
            price: point.price,
          }));
        } catch (_) { item.name = "unsupported_object"; }
        record.drawings.push(item);
      }
    } catch (_) { record.status = "unsupported_chart"; }
    charts.push(record);
  }
  return { version: 1, charts };
}
