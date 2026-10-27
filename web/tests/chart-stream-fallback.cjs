// The diagnostic polling mode has always retained supplier SSE. Its retired
// provider channel must be replaced with the same unified channel as normal mode.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const {read} = require('./fixtures/direct-runtime.cjs');
const messages = [], handlers = [];
const context = vm.createContext({URLSearchParams, Map, Set, Promise, Date, Intl, Error,
  location: {search: '?marketPolling=1'}, parent: {postMessage: value => messages.push(value)},
  crypto: {randomUUID: () => 'supplier'}, setTimeout, clearTimeout, queueMicrotask,
  addEventListener: (name, callback) => {if (name === 'message') handlers.push(callback);}});
for (const file of ['series.js', 'composite-display-batches.js', 'chart-runtime.js'])
  vm.runInContext(read(path.join(__dirname, '../../advanced-host', file), 'utf8'), context);
const evaluate = code => vm.runInContext(code, context);
(async () => {
  evaluate(`globalThis.bars=[];
    acceptMarketHistory('MWP:EURUSD','1',{bars:[{start:60000,end:120000}],as_of:1000});
    feed.subscribeBars({ticker:'MWP:EURUSD'},'1',bar=>bars.push(bar),'native',()=>{});`);
  const registration = messages.find(value => value.type === 'market-subscribe')?.args;
  assert.ok(registration, 'polling fallback lost supplier bar updates');
  assert.equal(registration.history_accepted, true);
  assert.equal(registration.loaded_after, 60000);
  await handlers[0]({data: {type:'market-event', event: {
    listener: registration.listener, generation: registration.generation, sequence: 1,
    type: 'bars', bars: [{start:120000,end:180000,open:1,high:2,low:1,close:2}],
  }}});
  assert.equal(context.bars.length, 1);
  evaluate(`feed.unsubscribeBars('native')`);
  assert.ok(messages.some(value => value.type === 'market-unsubscribe'));
  console.log('PASS: polling fallback retains unified supplier SSE and cancellation');
})().catch(error => {console.error(error); process.exitCode = 1;});
