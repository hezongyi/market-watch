const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const events = [];
const context = vm.createContext({
  URL,
  URLSearchParams,
  Map,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage(message) { if (message.type === "error" || (message.type === "feed-poll-state" && message.error)) events.push("error:" + message.error); } },
  crypto: { randomUUID: () => "test" },
  addEventListener() {},
  setTimeout,
  clearTimeout,
  events,
});
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), context);
(async () => {
  await vm.runInContext(
    `
ready = true;
widget = {chartsCount:()=>2, chart:(i)=>({
  symbol:()=> 'EURUSD', resolution:()=>i ? '60' : '5',
  resetData:()=>events.push('chart:'+i)
})};
subscriptions.set('five', {symbol:'EURUSD',res:'5', reset:()=>events.push('cache:5')});
subscriptions.set('hour', {symbol:'EURUSD',res:'60', reset:()=>events.push('cache:60')});
pendingHistory.set('EURUSD|5',{instrument:'EURUSD',timeframe:'M5'});
request = async()=>({status:'ready'});
query = async()=>({bars:[], history_revision:'one'});
tick();
`,
    context,
  );
  assert.deepEqual(events, ["cache:5", "chart:0"]);
  events.length = 0;
  await vm.runInContext(
    `
subscriptions.delete('hour');
query = async()=>({bars:[],history_check:{before:100,next_before:100,revision:'a',next_revision:'a'}});
tick();`,
    context,
  );
  await vm.runInContext(
    `
query = async()=>({bars:[],history_check:{before:100,next_before:200,revision:'a',next_revision:'b'}});
tick();`,
    context,
  );
  assert.deepEqual(events, []);
  await vm.runInContext(
    `
query = async()=>({bars:[],history_check:{before:200,next_before:200,revision:'changed',next_revision:'changed'}});
tick();`,
    context,
  );
  assert.deepEqual(events, ["cache:5", "chart:0"]);
  events.length = 0;
  await vm.runInContext(
    `
query = async()=>({bars:[],history_check:{before:200,after:10,next_before:200,revision:'expanded',next_revision:'expanded'}});
tick();`,
    context,
  );
  assert.deepEqual(events, [], "expanded history establishes a new baseline");
  await vm.runInContext(
    `
query = async()=>({bars:[],history_check:{before:200,after:10,next_before:200,revision:'corrected',next_revision:'corrected'}});
tick();`,
    context,
  );
  assert.deepEqual(
    events,
    ["cache:5", "chart:0"],
    "correction inside unchanged bounds reloads",
  );
  events.length = 0;
  await vm.runInContext(
    `
subscriptions.clear();
pendingHistory.set('old',{instrument:'XAUUSD',timeframe:'M5'});
request = async()=>{events.push('unexpected-request');return {status:'pending'}};
tick();`,
    context,
  );
  assert.deepEqual(events, []);
  assert.equal(vm.runInContext("pendingHistory.size", context), 0);
  await vm.runInContext(
    `
pendingHistory.set('same',{instrument:'EURUSD',timeframe:'M5',before:1});
request = async()=>{
  pendingHistory.set('same',{instrument:'EURUSD',timeframe:'M5',before:2});
  return {status:'ready'};
};
tick();`,
    context,
  );
  assert.equal(
    vm.runInContext("pendingHistory.get('same')?.before", context),
    2,
  );
  assert.deepEqual(events, []);
  events.length = 0;
  await vm.runInContext(
    `
pendingHistory.clear();
let retryCallback;
widget.showConfirmDialog = (options)=>{retryCallback=options.callback;events.push('dialog')};
rememberHistoryFailure({instrument:'EURUSD',timeframe:'M5'}, {failed_task_ids:['job','job']});
offerHistoryRetry();
request = async(q)=>{events.push(q.op+':'+q.args.id);return {ok:true}};
retryCallback(true);`,
    context,
  );
  assert.deepEqual(events, ["dialog", "retry:job"]);
  assert.equal(vm.runInContext("pendingHistory.size", context), 1);
  events.length = 0;
  await vm.runInContext(
    `
pendingHistory.clear();
widget={chartsCount:()=>1,chart:()=>({symbol:()=> 'EURUSD',resolution:()=> '5',
  getAllStudies:()=>[{id:'comparison',name:'Compare'}],
  getStudyById:()=>({getInputValues:()=>[{id:'symbol',value:'XAUUSD'}]}),
  resetData:()=>events.push('comparison-chart')})};
pendingHistory.set('compare',{instrument:'XAUUSD',timeframe:'M5'});
request=async()=>{events.push('history');return {status:'ready'}};
tick();`,
    context,
  );
  assert.deepEqual(events, ["history", "comparison-chart"]);
  events.length = 0;
  await vm.runInContext(`(async()=>{
pendingHistory.clear();
subscriptions.clear();
request = async()=>({ok:true});
for (let i=0;i<8;i++) subscriptions.set('pane-'+i,{
  symbol:'EURUSD',res:'5',last:0,
  cb:bar=>events.push('bar:'+i+':'+bar.close),reset:()=>{}
});
globalThis.queryCalls=0;
query=async()=>{queryCalls++;throw Error('simulated temporary upstream failure')};
await tick();
})()`, context);
  assert.equal(vm.runInContext("polling", context), false);
  assert.equal(vm.runInContext("queryCalls", context), 1);
  assert.equal(events.length, 1);
  assert.match(events[0], /temporary upstream failure/);
  events.length = 0;
  await vm.runInContext(`(async()=>{
query=async()=>{queryCalls++;return {bars:[{start:300000,open:1,high:2,low:1,close:1.5}]}};
await tick();
})()`, context);
  assert.equal(vm.runInContext("queryCalls", context), 2);
  assert.equal(events.length, 8, "Recovered grouped query updates all eight subscribers");
  assert.ok(events.every(event => event.endsWith(":1.5")));
  assert.equal(vm.runInContext("subscriptions.size", context), 8);
  assert.equal(vm.runInContext("polling", context), false);
  events.length = 0;
  await vm.runInContext(`(async()=>{
let releaseQuery;
query=()=>{queryCalls++;return new Promise(resolve=>{releaseQuery=resolve})};
const runningTick=tick();
await Promise.resolve();
await tick();
releaseQuery({bars:[]});
await runningTick;
})()`, context);
  assert.equal(vm.runInContext("queryCalls", context), 3,
    "An overlapping timer tick must not issue a second request");
  assert.equal(vm.runInContext("polling", context), false);
  events.length = 0;
  await vm.runInContext(`(async()=>{
subscriptions.clear();
widget={chartsCount:()=>1,chart:()=>({symbol:()=> 'EURUSD',resolution:()=> '5',
  resetData:()=>events.push('visible-reset')})};
subscriptions.set('hidden',{symbol:'XAUUSD',res:'5',last:0,
  reset:()=>events.push('hidden-cache-reset'),cb:()=>events.push('hidden-bar')});
query=async()=>{events.push('query');return {bars:[]}};
await tick();
})()`, context);
  assert.deepEqual(events, [], "Hidden pane must not fetch latest bars");
  assert.equal(vm.runInContext("subscriptions.get('hidden').pausedForLayout", context), true);
  await vm.runInContext(`(async()=>{
widget={chartsCount:()=>1,chart:()=>({symbol:()=> 'XAUUSD',resolution:()=> '5',
  resetData:()=>events.push('visible-reset')})};
await tick();
})()`, context);
  assert.deepEqual(events, ['hidden-cache-reset', 'visible-reset'],
    "Reopening must refill history before resuming latest-bar polling");
  events.length = 0;
  await vm.runInContext("tick()", context);
  assert.deepEqual(events, ['query']);
  events.length = 0;
  await vm.runInContext(`(async()=>{
widget={chartsCount:()=>1,chart:()=>({symbol:()=> 'EURUSD',resolution:()=> '5',
  getAllStudies:()=>[{id:'comparison'}],
  getStudyById:()=>({getInputValues:()=>[{id:'symbol',value:'XAUUSD'}]})})};
await tick();
})()`, context);
  assert.deepEqual(events, ['query'], "Visible comparison must keep its own polling demand");
  events.length = 0;
  await vm.runInContext(`(async()=>{
request=async()=>{throw Error('activity unavailable')};
await tick();
})()`, context);
  assert.equal(vm.runInContext("polling",context),false);
  assert.deepEqual(events,['error:Error: activity unavailable']);
  events.length=0;
  await vm.runInContext(`(async()=>{request=async()=>({ok:true});await tick()})()`,context);
  assert.deepEqual(events,['query'],'polling must recover after activity renewal failure');
  console.log("Grouped polling recovers after failure and prevents overlapping requests");
  console.log(
    "Historical reload invalidates matching cache before resetting only matching panes",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
