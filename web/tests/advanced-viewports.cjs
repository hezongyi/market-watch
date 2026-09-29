const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({ setTimeout });
vm.runInContext(
  fs.readFileSync("../advanced-host/viewports.js", "utf8"),
  context,
);
(async () => {
  let sync = true,
    spacing = 10,
    offset = 10,
    preference = 10;
  const ranges = [];
  const chart = {
    symbol: () => "EURUSD",
    resolution: () => "1D",
    getVisibleRange: () => ({ from: 100, to: 200 }),
    dataReady: (callback) => callback(),
    setVisibleRange: async (range) => ranges.push(range),
    getTimeScale: () => ({
      barSpacing: () => spacing,
      rightOffset: () => offset,
      width: () => 1000,
      setBarSpacing: (value) => (spacing = value),
      setRightOffset: (value) => (offset = value),
      defaultRightOffset: () => ({ setValue: (value) => (preference = value) }),
    }),
  };
  const widget = {
    chartsCount: () => 1,
    chart: () => chart,
    dateRangeSync: () => ({
      value: () => sync,
      setValue: (value) => (sync = value),
    }),
  };
  const saved = context.captureChartViewports(widget);
  saved[0].offset = 9;
  saved[0].spacing = 14.7;
  await context.restoreChartViewports(widget, saved, () => true);
  assert.equal(offset, 9);
  assert.equal(spacing, 14.7);
  assert.equal(preference, 10, "must not change default margin");
  assert.equal(sync, true);
  saved[0].offset = -20;
  await context.restoreChartViewports(widget, saved, () => true);
  assert.equal(ranges.length, 1, "historical position must restore dates");
  saved[0].symbol = "XAUUSD";
  await context.restoreChartViewports(widget, saved, () => true);
  assert.equal(ranges.length, 1, "must not apply to a different symbol");
  saved[0].symbol = "EURUSD";
  chart.setVisibleRange = async () => {
    throw Error("history failed");
  };
  await assert.rejects(
    context.restoreChartViewports(widget, saved, () => true),
    /history failed/,
  );
  assert.equal(
    sync,
    true,
    "failed restore must restore synchronization preference",
  );
  await context.restoreChartViewports(widget, saved, () => false);
  assert.equal(
    sync,
    true,
    "stale restore must leave current workspace untouched",
  );
  console.log(
    "Viewport restoration preserves preferences and checks symbol identity",
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
