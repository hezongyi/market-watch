// Exercise the real bridge through the native thread wrapper, including hidden
// cached periods. HTTP responses are controlled; this is not browser acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const messages = [], handlers = [];
let sequence = 0;
let reserveRead;
const ctx = vm.createContext({
  document: {createElement: () => ({}), head: {append() {}}},
  URL, URLSearchParams, Map, Set, Promise, Date, Intl, Error, Number, Math,
  atob, btoa, performance, queueMicrotask, setTimeout, clearTimeout,
  location: {search: '?parent=http://localhost'},
  parent: {postMessage: message => messages.push(message)},
  crypto: {randomUUID: () => String(++sequence)},
  addEventListener: (name, fn) => {if (name === 'message') handlers.push(fn);},
  dispatchEvent() {}, CustomEvent: class {},
  MWNativeReserve: {configure: read => {reserveRead=read;},delivered() {}},
  requestAnimationFrame: callback => setImmediate(callback),
});
for (const file of ['series.js', 'native-navigation.js', 'chart-runtime.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../advanced-host', file), 'utf8'), ctx);
const run = source => vm.runInContext(source, ctx);
const tick = () => new Promise(resolve => setTimeout(resolve, 160));
const reply = async (message, result) => handlers[0]({
  source: ctx.parent, origin: 'http://localhost',
  data: {channel: 'mw-chart-v1', type: 'result', id: message.id, result},
});
const page = {
  bars: [{start: 1000, chart_time: 1000, end: 2000, open: 1, high: 2, low: 0, close: 1, complete: true}],
  has_more: false,
};
(async () => {
  run(`ready=true; widget={chartsCount:()=>1,chart:()=>({
    symbol:()=> 'MWP:BTCUSDT',resolution:()=> '60',getAllStudies:()=>[]})};
    globalThis.successes=[]; globalThis.failures=[];
    globalThis.makeThread=ticker=>({
      _symbolInfo:{ticker},_resolution:'5',_cache:{bars:[]},_datafeed:feed,
      _dealignTime:time=>time,_purgeCache(){this._cache={bars:[]};}
    });
    globalThis.load=thread=>thread._datafeed.getBars(thread._symbolInfo,'5',
      {from:0,to:100,countBack:1},bars=>successes.push(bars),error=>failures.push(error));`);
  const fixed = ['MWH:00000000-0000-0000-0000-000000000001', 'MWC:' + 'a'.repeat(64)];
  fixed.push('MWPY_' + btoa(JSON.stringify({symbol: fixed[1], spec: {name: 'SMA', params: {period: 2}}, key: 'value'})));
  for (const ticker of fixed) {
    run(`globalThis.thread=makeThread(${JSON.stringify(ticker)});MWNativeNavigation.bindThread(thread,'5');`);
    const before = messages.length, delivered = run('successes.length');
    const promise = run('load(thread)');
    await tick();
    const sent = messages.slice(before).find(message => message.type === 'data');
    assert.ok(sent, 'hidden fixed consumer reaches data API');
    await reply(sent, {...page, indicators: [{series: [{key: 'value', values: [{time: 1000, value: 1}]}]}]});
    await promise;
    assert.equal(run('successes.length'), delivered + 1, 'hidden native period cache receives bars');
    assert.equal(run('failures.length'), 0);
    run('MWNativeNavigation.unbindThread(thread)');
  }
  for (const cancel of ['thread._purgeCache()', 'MWNativeNavigation.unbindThread(thread)', 'workspaceEpoch++']) {
    run(`thread=makeThread(${JSON.stringify(fixed[1])});MWNativeNavigation.bindThread(thread,'5');`);
    const before = messages.length, delivered = run('successes.length');
    const promise = run('load(thread)');
    await tick();
    const sent = messages.slice(before).find(message => message.type === 'data');
    assert.ok(sent);
    run(cancel);
    await tick();
    await reply(sent, page);
    await promise;
    assert.equal(run('successes.length'), delivered, 'late response cannot populate obsolete cache');
    assert.equal(run('failures.at(-1).code'), 'HISTORY_CANCELLED', 'fixed failure retains structured cancellation');
    run('MWNativeNavigation.unbindThread(thread)');
  }
  // Cancel after page one: no second request or callback may outlive the owner.
  run(`thread=makeThread(${JSON.stringify(fixed[1])});MWNativeNavigation.bindThread(thread,'5');`);
  const before = messages.length;
  const promise = run(`thread._datafeed.getBars(thread._symbolInfo,'5',{from:0,to:100,countBack:2},
    bars=>successes.push(bars),error=>failures.push(error))`);
  await tick();
  const sent = messages.slice(before).find(message => message.type === 'data');
  run('thread._purgeCache()');
  await reply(sent, {...page, has_more: true, next_before: 1000});
  await promise;
  assert.equal(messages.slice(before).filter(message => message.type === 'data').length, 1);
  assert.equal(run('failures.at(-1).code'), 'HISTORY_CANCELLED');
  run(`MWNativeNavigation.setCapabilities({protocol:1,mode:'continuous',max_bars:40000,workspace_bars:100000});
    globalThis.MW_HISTORY_CAPABILITIES={task_pages:30,task_seconds:30};
    thread=makeThread(${JSON.stringify(fixed[1])});MWNativeNavigation.bindThread(thread,'5');`);
  const largeStart=messages.length,largeDelivered=run('successes.length');
  const large=run(`thread._datafeed.getBars(thread._symbolInfo,'5',{from:0,to:3000000,countBack:21001},
    bars=>successes.push(bars),error=>failures.push(error))`);
  let consumed=largeStart,end=22002,partitions=0;
  while(run('successes.length')===largeDelivered && partitions<12){
    await tick();if(run('successes.length')>largeDelivered)break;
    const sent=messages.slice(consumed).find(message=>message.type==='data');assert.ok(sent,`large fixed request advances (${partitions}; ${run('failures.at(-1)?.stack')})`);
    consumed=messages.indexOf(sent)+1;
    if(partitions)assert.equal(sent.query.composite_revision_id,'accepted-revision');
    if(partitions)assert.equal(sent.query.input_revision,7);
    const amount=sent.query.limit;
    const bars=Array.from({length:amount},(_,i)=>({start:(end-amount+i)*60000,end:(end-amount+i+1)*60000,chart_time:(end-amount+i)*60000,open:1,high:2,low:0,close:1,complete:true}));
    end-=amount;partitions++;
    await reply(sent,{bars,has_more:true,next_before:bars[0].start,revision_id:'accepted-revision',input_revision:7});
  }
  await large;assert.equal(run('successes.length'),largeDelivered+1);assert.equal(run('successes.at(-1).length'),21001);
  assert.equal(partitions,11);assert.equal(run('successes.at(-1).every((bar,i,all)=>!i||bar.time>all[i-1].time)'),true);
  run('MWNativeNavigation.unbindThread(thread)');
  run(`MW_HISTORY_CAPABILITIES={task_pages:1,task_seconds:30};thread=makeThread(${JSON.stringify(fixed[0])});MWNativeNavigation.bindThread(thread,'5');`);
  const budgetStart=messages.length,budgetDelivered=run('successes.length');
  const exhausted=run(`thread._datafeed.getBars(thread._symbolInfo,'5',{from:0,to:100000,countBack:2001},bars=>successes.push(bars),error=>failures.push(error))`);
  await tick();const budgetRequest=messages.slice(budgetStart).find(m=>m.type==='data');
  await reply(budgetRequest,{...page,has_more:true,next_before:1000});await exhausted;
  assert.equal(run('successes.length'),budgetDelivered);assert.equal(run('failures.at(-1).code'),'HISTORY_PAGE_BUDGET');
  run('MWNativeNavigation.unbindThread(thread)');
  // A composite reserve completing during an input-generation change cannot
  // enter the native cache even when the immutable revision stays unchanged.
  for (const replacement of [7,8,'mutate']) {
    const symbol=fixed[1],key=symbol+'|5|';
    run(`marketHistoryState.set(${JSON.stringify(key)},{binding:'accepted-revision',input_revision:7});`);
    const start=messages.length;
    const reserve=reserveRead({symbol:symbol.toUpperCase(),resolution:'5',before:60000,screen_bars:100,batch_screens:1,current:()=>true});
    await tick();const sent=messages.slice(start).find(m=>m.type==='data');assert.ok(sent);
    assert.equal(sent.query.composite_revision_id,'accepted-revision');assert.equal(sent.query.input_revision,7);
    if(replacement==='mutate')run(`marketHistoryState.get(${JSON.stringify(key)}).input_revision=8;`);
    else run(`marketHistoryState.set(${JSON.stringify(key)},{binding:'accepted-revision',input_revision:${replacement}});`);
    await reply(sent,{...page,revision_id:'accepted-revision',input_revision:7});
    if(replacement===7)assert.equal((await reserve).bars.length,1);
    else await assert.rejects(reserve,{code:'HISTORY_CANCELLED'});
  }
  console.log('Fixed history, composite and Python cache lifetimes: hidden loads, purge, destroy, workspace and pagination passed');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {
  for (const entry of run('[...pending.values()]')) {
    clearTimeout(entry.timer); clearTimeout(entry.cancellationTimer);
  }
});
