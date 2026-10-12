/* Numerical values come exclusively from Python; exercise native plot mapping. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fixture = JSON.parse(fs.readFileSync('../backend/tests/fixtures/supertrend_pine_v1.json'));
const context = vm.createContext({
  btoa: s => Buffer.from(s).toString('base64'),
  PineJS: {Std: {
    period: () => '1D', time: ctx => ctx.index ? ctx.time : ctx.time,
    volume: ctx => ctx.value == null ? 0 : (ctx.breakBefore ? 2 : 1), close: ctx => ctx.value,
  }},
  catalog: {SUPERTREND_PINE_V1: {
    pane: 'main', render_profile: 'supertrend_pine_v1',
    params: {period: 10, source: 'hl2', multiplier: 3, atr_method: 'wilder'},
    series: ['up', 'down', 'buy_price', 'sell_price', 'fill_reference', 'direction'].map(key => ({key,type:'line'})),
  }},
});
vm.runInContext(fs.readFileSync('../advanced-host/indicators.js','utf8'), context);
const study = vm.runInContext('pythonStudies(PineJS,catalog)[0]', context);
const meta = study.metainfo;
assert.equal(meta.id, 'MWPythonSUPERTREND_PINE_V1@market-watch-1');
assert.equal(meta.format.precision, 2);
assert.equal(meta.defaults.styles.up.plottype, 7);
assert.equal(meta.defaults.styles.down.plottype, 7);
assert.equal(meta.styles.buy_label.text, 'Buy');
assert.equal(meta.styles.sell_label.text, 'Sell');
assert.equal(meta.defaults.styles.buy_dot.location, 'Absolute');
assert.equal(meta.defaults.styles.sell_dot.location, 'Absolute');
assert.equal(meta.defaults.styles.fill_reference.linewidth, 0);
assert.equal(meta.defaults.styles.fill_reference.transparency, 100);
assert.equal(meta.defaults.styles.up_fill.display, 0);
assert.ok(meta.filledAreas.every(fill => !fill.fillgaps));
assert.deepEqual(Array.from(meta.inputs.slice(3), input => input.type), ['bool','bool','bool']);
assert.deepEqual(Array.from(meta.inputs[1].options), ['open','high','low','close','hl2','hlc3','ohlc4']);

function run(inputValues, at=5, values=fixture.wilder, breakBefore=false) {
  const feeds = [];
  const calculator = new study.constructor();
  const ctx = {
    breakBefore,
    symbol: {info: {ticker: 'MWP:EURUSD', mw_window: 'supertrend-window'}},
    new_sym(ticker) {feeds.push(JSON.parse(ticker.slice(1)));},
    select_sym(index) {
      this.index = index; this.time = at * 60000;
      this.value = index ? values[['up','down','buy_price','sell_price','fill_reference'][index-1]][at] : null;
    },
    new_var(value) {return {adopt: () => value};},
  };
  calculator.init(ctx, i => inputValues[i]);
  const result = Array.from(calculator.main(ctx, i => inputValues[i]));
  assert.equal(ctx.index, 0);
  return {feeds, result};
}
const shown = run([10,'hl2',3,true,true,true]);
assert.equal(shown.feeds.length, 5, 'one feed per numerical series, no duplicate labels or direction');
const specs = shown.feeds.map(feed => {
  assert.equal(feed['mw-window'], 'supertrend-window');
  return JSON.parse(Buffer.from(feed.symbol.slice(5),'base64').toString()).spec;
});
assert.ok(specs.every(spec => JSON.stringify(spec) === JSON.stringify(specs[0])));
assert.deepEqual(specs[0].params, {period:10,source:'hl2',multiplier:3,atr_method:'wilder'});
assert.equal(shown.result[0], 9.25);
assert.equal(shown.result[5], shown.result[7], 'Buy circle and label use the same updated U');
const hidden = run([10,'hl2',3,true,false,false]);
assert.equal(hidden.result[5], shown.result[5], 'hiding labels retains circles');
assert.ok(hidden.result.slice(3,5).every(Number.isNaN), 'highlighting only gates dedicated fill plots');
assert.ok(hidden.result.slice(7).every(Number.isNaN));
assert.deepEqual(hidden.feeds, shown.feeds, 'display switches do not alter computation identity');
const sell = run([10,'ohlc4',3,false,true,true], 3, fixture.sma);
assert.equal(sell.result[6], 13);
assert.equal(sell.result[6], sell.result[8]);
assert.equal(JSON.parse(Buffer.from(sell.feeds[0].symbol.slice(5),'base64').toString()).spec.params.atr_method, 'sma');
const zero = Object.fromEntries(Object.keys(fixture.wilder).map(key => [key,[0]]));
assert.equal(run([1,'close',0.1,true,true,true],0,zero).result[5],0,'legitimate zero remains visible');
const gap = run([1,'close',0.1,true,true,true],0,zero,true);
assert.ok(gap.result.slice(0,5).every(Number.isNaN),'period 1 breaks trend lines and both fills at a true gap');
assert.equal(gap.result[5],0,'break markers cannot erase signal anchors');
console.log('Supertrend native profile: inputs, fixed identity, line breaks, sparse feeds, absolute anchors, display switches and zero/null passed');
