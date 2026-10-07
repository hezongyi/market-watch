// Called only from the verified native empty-pane double-click branch, after
// native source hit testing, drawing-in-progress and selection checks.
function chartBlankDoubleClick(widget, { readonly = false } = {}) {
  let resizeEpoch = 0, resizing = false, frame = 0, disposed = false;
  return {
    resizing: () => resizing,
    dispose() {
      disposed = true;
      resizeEpoch++;
      resizing = false;
      cancelAnimationFrame(frame);
      frame = 0;
    },
    handle(pane, event) {
      if (
        disposed || readonly || event.isTouch || event.altKey || event.ctrlKey ||
        event.metaKey || event.shiftKey || event.target?.tagName !== "CANVAS" ||
        !pane.containsMainSeries() ||
        widget.chartsCount() < 2
      ) return false;

      // Bind to the clicked chart, never to a possibly stale active chart.
      for (let i = 0; i < widget.chartsCount(); i++) {
        const chart = widget.chart(i);
        if (chart._chartWidget !== pane._chart) continue;
        if (!chart.dataReady() || !pane._chart.getResizerDetacher().fullscreenable.value())
          return false;
        // Resizing changes the visible date range without a navigation input.
        // Keep native date-sync choices intact, but exclude this short resize
        // from propagation to the other charts.
        const epoch = ++resizeEpoch;
        cancelAnimationFrame(frame);
        resizing = true;
        try {
          widget.setActiveChart(i);
          if (chart.isMaximized()) chart.restoreChart();
          else chart.maximizeChart();
        } finally {
          let previous, stable = 0;
          const settled = () => {
            if (epoch !== resizeEpoch) return;
            const dimensions = JSON.stringify(Array.from({length:widget.chartsCount()},(_,j)=>
              [widget.chart(j).getTimeScale().width(), ...widget.chart(j).getPanes().map(p=>p.getHeight())]));
            stable = dimensions === previous ? stable + 1 : 0;
            previous = dimensions;
            if (stable >= 3) { resizing = false; frame = 0; }
            else frame = requestAnimationFrame(settled);
          };
          frame = requestAnimationFrame(settled);
        }
        return true;
      }
      return false;
    },
  };
}
