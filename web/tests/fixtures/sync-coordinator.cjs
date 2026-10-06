// Use the real coordinator for existing guard/snapshot/viewport regression mocks.
const fs = require("node:fs"),
  vm = require("node:vm");
module.exports = function attach(context, widget) {
  context.requestAnimationFrame ||= (fn) => setTimeout(fn, 0);
  context.cancelAnimationFrame ||= clearTimeout;
  vm.runInContext(
    fs.readFileSync("../advanced-host/sync-coordinator.js", "utf8"),
    context,
  );
  widget.subscribe ||= () => {};
  widget.unsubscribe ||= () => {};
  widget.activeChart ||= () => widget.chart(0);
  const emptyEvent = () => ({ subscribe() {}, unsubscribe() {} });
  for (let i = 0; i < widget.chartsCount(); i++) {
    const chart = widget.chart(i);
    chart.onSymbolChanged ||= emptyEvent;
    chart.onIntervalChanged ||= emptyEvent;
    chart.chartType ||= () => 1;
  }
  for (const key of ["dateRangeSync", "timeSync"]) {
    if (!widget[key]) {
      let value = false;
      const toggle = {
        value: () => value,
        setValue: (v) => {
          value = v;
        },
        subscribe() {},
        unsubscribe() {},
      };
      widget[key] = () => toggle;
    }
    const toggle = widget[key]();
    widget[key] = () => toggle;
    toggle.subscribe ||= () => {};
    toggle.unsubscribe ||= () => {};
  }
  return context.chartSyncCoordinator(widget);
};
