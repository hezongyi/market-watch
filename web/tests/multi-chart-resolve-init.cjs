// Exercise the shipped datafeed while native layout models attach or detach.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const messages = [], handlers = {};
const ticker = 'MWP:XAUUSD';
function chart(resolution, fault = null) {
  return { fault, symbol() {
    if (this.fault === 'symbol') throw Error('Value is null');
    return ticker;
  }, resolution() {
    if (this.fault === 'resolution') throw Error('Value is null');
    return resolution;
  } };
}
const charts = [chart('60'), chart('5', 'resolution'), chart('1W'),
  chart('1D'), chart('240')];
const ctx = vm.createContext({
  document: { createElement: () => ({}), head: { append() {} } },
  URL, URLSearchParams, Map, Promise, Date, Intl, Error, setTimeout, clearTimeout,
  location: { search: '?parent=http://localhost' },
  parent: { postMessage: message => messages.push(message) },
  crypto: { randomUUID: () => String(messages.length) },
  addEventListener: (name, fn) => (handlers[name] ??= []).push(fn), charts,
});
for (const file of ['series.js', 'composite-display-batches.js', 'bridge.js'])
  vm.runInContext(fs.readFileSync('../advanced-host/' + file, 'utf8'), ctx);
const run = code => vm.runInContext(code, ctx);
run(`widget={chartsCount:()=>charts.length,chart:index=>charts[index]};
  workspaceEpoch=1;globalThis.resolved=[];globalThis.errors=[];`);
const meta = { source:'oanda', symbol:'XAUUSD', precision:3,
  frames:['M1','M5','H1','H4','D1','W1'], calendar:'ny17', basis:'bid' };
const state = () => messages.filter(row => row.type === 'chart-resolve-states').at(-1);
function start() {
  return run(`feed.resolveSymbol('${ticker}', info=>resolved.push(info), error=>errors.push(error))`);
}
async function respond(message, data = { result: meta }) {
  for (const handler of handlers.message)
    await handler({ source:ctx.parent, origin:'http://localhost',
      data:{ channel:'mw-chart-v1', type:'result', id:message.id, ...data } });
}
async function resolve(change) {
  const flight = start();
  // Surface early datafeed rejection without leaving its request timer pending.
  flight.catch(() => {});
  const message = messages.filter(row => row.type === 'market').at(-1);
  if (message) {
    if (change) change();
    await respond(message);
  }
  await flight;
}
(async () => {
  try {
    await resolve();
    assert.equal(ctx.resolved.length, 1, 'restoring models cannot prevent the native resolve callback');
    assert.equal(ctx.errors.length, 0);
    assert.equal(state().states.length, 0);

    charts[1].fault = null;
    charts[3].fault = null;
    const first = start();
    const firstMessage = messages.filter(row => row.type === 'market').at(-1);
    const second = start();
    const secondMessage = messages.filter(row => row.type === 'market').at(-1);
    assert.deepEqual(Array.from(state().states, row => row.index).sort(), [0,1,2,3,4],
      'all five attached chart lifetimes are tracked');
    await respond(firstMessage);
    await respond(secondMessage);
    await Promise.all([first, second]);
    assert.equal(ctx.resolved.length, 3, 'parallel same-symbol native consumers both complete');

    charts[3].fault = 'symbol';
    const partial = start();
    assert.deepEqual(Array.from(state().states, row => row.index).sort(), [0,1,2,4],
      'one unavailable symbol accessor cannot discard other attached chart targets');
    await respond(messages.filter(row => row.type === 'market').at(-1));
    await partial;
    charts[3].fault = null;

    await resolve(() => { charts[0].fault = 'resolution'; });
    assert.equal(ctx.resolved.length, 5, 'one detached chart cannot cancel other attached consumers');
    charts[0].fault = null;

    await resolve(() => { for (const chart of charts) chart.fault = 'resolution'; });
    assert.equal(ctx.resolved.length, 5, 'detaching every captured target fences late metadata');

    await resolve();
    assert.equal(ctx.resolved.length, 6, 'metadata still resolves when no native model has attached yet');
    for (const chart of charts) chart.fault = null;
    await resolve(() => run('workspaceEpoch++'));
    assert.equal(ctx.resolved.length, 6, 'workspace change still fences in-flight metadata');
    console.log('PASS multi-chart initialization, partial teardown, parallel resolve and stale lifetime fencing');
  } finally {
    for (const entry of run('[...pending.values()]')) {
      clearTimeout(entry.timer);
      clearTimeout(entry.cancellationTimer);
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
