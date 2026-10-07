const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({ setTimeout, requestAnimationFrame: callback => setTimeout(callback, 0) });
vm.runInContext(
  fs.readFileSync("../advanced-host/viewports.js", "utf8"),
  context,
);
(async () => {
  let sync = true, timeSync = true,
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
    timeSync: () => ({value: () => timeSync,setValue: value => {timeSync=value;}}),
  };
  const attach=require("./fixtures/sync-coordinator.cjs");
  attach(context,widget);
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
  let attempts=0;
  chart.setVisibleRange=async range=>{
    if(++attempts<3) throw Error('Value is null');
    ranges.push(range);
  };
  await context.restoreChartViewports(widget,saved,()=>true);
  assert.equal(attempts,3,'native metadata readiness must retry bounded transient failures');
  const restoredCount=ranges.length;
  saved[0].symbol = "XAUUSD";
  await context.restoreChartViewports(widget, saved, () => true);
  assert.equal(ranges.length, restoredCount, "must not apply to a different symbol");
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
  // A ready first pane must not restore geometry while another pane still
  // loads. Native synchronization can have a queued range call to that pane.
  let secondReady=false, releaseSecond;
  const first={...chart,dataReady:callback=>callback(),setVisibleRange:async()=>{
    assert.equal(secondReady,true,'all pane data must precede range restoration');
    assert.equal(timeSync,false,'time synchronization must not move peers during restoration');
  }};
  const second={...chart,dataReady:callback=>{
    if(secondReady)callback();else releaseSecond=()=>{secondReady=true;callback()};
  }};
  const multi={...widget,chartsCount:()=>2,chart:index=>index?second:first};
  attach(context,multi);
  const restoring=context.restoreChartViewports(multi,saved,()=>true);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(typeof releaseSecond,'function','restoration must observe every pane before the first mutation');
  assert.equal(sync,true,'initial native date synchronization must settle before changing its toggle');
  assert.equal(timeSync,true,'initial native time synchronization must settle before changing its toggle');
  releaseSecond();
  await restoring;
  assert.equal(timeSync,true,'restore the actual saved time-sync preference');
  // A saved synchronized layout has one date-range authority. Updating every
  // pane independently interrupts native peer synchronization during reopen.
  const order=[];
  const panes=[0,1].map(index=>({...chart,dataReady:callback=>callback(),setVisibleRange:async()=>{
    assert.equal(sync,true,'keep native date synchronization active');
    assert.equal(timeSync,true,'keep native time synchronization active');
    order.push(index);
  }}));
  const synced={...widget,chartsCount:()=>2,chart:index=>panes[index],activeChartIndex:()=>1,activeChart:()=>panes[1]};
  attach(context,synced);
  await context.restoreChartViewports(synced,[saved[0],saved[0]],()=>true);
  assert.deepEqual(order,[1],'only the active pane restores a fully synchronized saved layout');
  order.length=0;
  const recent={...saved[0],offset:10,spacing:14.7};
  await context.restoreChartViewports(synced,[recent,recent],()=>true);
  assert.deepEqual(order,[],'latest-margin restore must use public scale geometry without an extra native goto');
  assert.equal(spacing,14.7);
  assert.equal(offset,10);
  console.log(
    "Viewport restoration preserves preferences and checks symbol identity",
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
