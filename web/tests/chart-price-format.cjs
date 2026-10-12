const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ Intl, Number, Math });
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../advanced-host/price-format.js'), 'utf8'), context);
const factory = context.chartPriceFormatter;
// The initiating chart's formatter controls defaults; storage gets a separate
// canonical decimal, never its grouped display text or interpolated JS number.
assert.equal(typeof context.chartAlertPricePresentation, 'function');
const alertPrice = (price, format) => context.chartAlertPricePresentation({priceFormatter: () => ({format})}, price);
for (const [price, text, decimal] of [
  [1.128313520286396, '1.12831', '1.12831'],
  [151.23456789, '151.235', '151.235'],
  [2651.12789, '2,651.13', '2651.13'],
  [62000.123456789, '62,000.12', '62000.12'],
  [252.29456789, '252.29', '252.29'],
  [0.000000014, '0.00000001', '0.00000001'],
  [10.023, '10.05', '10.05'],
]) {
  const value=alertPrice(price, () => text);
  assert.equal(value.text, text);
  assert.equal(value.value, decimal);
}
assert.throws(() => alertPrice(1, () => 'bad format'), /报价格式/);
for(const [text,scale,factor,value] of [["133'21",32,0,'133.65625'],["119'16'2",128,4,'119.5078125'],["119'16'7",128,4,'119.5234375'],["10'2",4,0,'10.25'],["10'5",8,0,'10.625']]){
 const actual=context.chartAlertPricePresentation({symbolExt:()=>({fractional:true,pricescale:scale,minmove2:factor}),priceFormatter:()=>({format:()=>text})},Number(value));
 assert.equal(actual.value,value);
}
assert.equal(alertPrice(10.014,()=> '\u202a10.02\u202c').value,'10.02','variable tick/native directional marks');
const formatter = precision => factory({ mw_range_source: 'yahoo', mw_display_precision: precision }, 'default');
assert.equal(formatter(2).format(530.82456789), '530.82');
assert.equal(formatter(2).format(-37.63), '-37.63');
assert.equal(formatter(2).formatChange(530.82, 530.82001), '0.00');
assert.equal(formatter(2).format(1.23, { signPositive: true }), '+1.23');
assert.equal(formatter(2).formatChange(530.83, 530.82, { signPositive: true }), '+0.01');
assert.equal(formatter(5).format(0.001234), '0.00123');
assert.equal(formatter(8).format(0.00000001), '0.00000001');
assert.equal(formatter(2).format(NaN), '—');
assert.equal(factory({ mw_range_source: 'yahoo', mw_display_precision: 2 }, '10000,1,false'), null);
assert.equal(factory({ mw_range_source: 'binance', mw_display_precision: 2 }, 'default'), null);
assert.equal(formatter(9).format(252.29456789), '252.29');
// Presentation must survive missing/overly precise supplier hints and adapt
// to the price being shown, not only the last cached quote.
const stock = factory({ mw_range_source: 'yahoo', type: 'stock', pricescale: 1e8 }, 'default');
assert.ok(stock, 'missing display metadata must not expose eight storage decimals');
assert.equal(stock.format(252.29456789), '252.29');
assert.equal(stock.format(0.001234), '0.00123');
assert.equal(stock.format(0.00000001), '0.00000001');
assert.equal(stock.formatChange(252.30, 252.29), '0.01');
assert.equal(factory({ mw_range_source: 'yahoo', type: 'stock', mw_display_precision: 8 }, 'default').format(252.29456789), '252.29');
assert.equal(factory({ mw_range_source: 'yahoo', type: 'forex', pricescale: 1e8 }, 'default').format(1.123456789), '1.12346');
assert.equal(factory({ mw_range_source: 'dukascopy', type: 'forex', pricescale: 1e8 }, 'default').format(1.123456789), '1.12346');
assert.equal(factory({ type: 'fund', pricescale: 1e8 }, 'default').format(650.25456789), '650.25');
assert.equal(factory({ mw_range_source: 'yahoo', type: 'stock' }, '100000000,1,false'), null);
assert.equal(factory({ mw_range_source: 'yahoo', type: 'stock', fractional: true }, 'default'), null);
assert.equal(factory({ mw_range_source: 'yahoo', type: 'stock', variable_tick_size: '0.01 10 0.02' }, 'default'), null);
assert.equal(stock.formatChange(0.001234, 0.001224), '0.00001');
assert.equal(stock.formatChange(252.29, 252.29001), '0.00');
assert.equal(stock.format(252.29456789), '252.29');
assert.equal(stock.format(-0.001234), '-0.00123');
assert.equal(stock.format(0), '0.00');
const quote = { s: 'ok', n: 'MWP:AAPL', v: { lp: 252.29456789, ch: 0.01456789 } };
const displayQuote = context.chartQuotePresentation(quote, { source: 'yahoo', asset_type: 'EQUITY', display_precision: 8 });
assert.equal(displayQuote.v.mw_display_pricescale, 100);
assert.equal(displayQuote.v.lp, quote.v.lp);
assert.equal(displayQuote.v.ch, quote.v.ch);
assert.equal(quote.v.mw_display_pricescale, undefined);
assert.equal(context.chartQuotePresentation({ ...quote, v: { lp: 0.001234 } }, { source: 'yahoo', asset_type: 'EQUITY' }).v.mw_display_pricescale, 1e5);
assert.equal(context.chartQuotePresentation(quote, { source: 'binance', asset_type: 'CRYPTO' }).v, quote.v);
assert.equal(context.chartQuoteScale(displayQuote, { pricescale: 1e8 }), 100);
assert.equal(context.chartQuoteScale(quote, { pricescale: 1e8 }), 1e8);
assert.equal(context.chartQuoteScale({ ...quote, v: { mw_display_pricescale: 25 } }, { pricescale: 1e8 }), 1e8);
assert.equal(context.chartQuoteScale(displayQuote, { pricescale: 1e8, fractional: true }), 1e8);
console.log('38 price formatting checks passed');
