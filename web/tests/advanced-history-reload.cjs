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
  parent: { postMessage() {} },
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
  console.log(
    "Historical reload invalidates matching cache before resetting only matching panes",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
