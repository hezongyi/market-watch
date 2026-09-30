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
(async()=>{
 await vm.runInContext(`
ready=true;
const chart={symbol:()=> 'EURUSD',resolution:()=> '5',getAllStudies:()=>[]};
widget={chartsCount:()=>1,chart:()=>chart};
rangeGuard={busy:()=>true};
subscriptions.set('pane',{symbol:'EURUSD',res:'5',pausedForLayout:true,last:0,cb:()=>{},reset:()=>{}});
request=async()=>({});
query=async()=>{events.push('poll');return {bars:[]}};
tick();`,context);
 assert.deepEqual(events,['poll'],'visible polling must resume even while viewport restoration is busy');
 assert.equal(vm.runInContext("subscriptions.get('pane').pausedForLayout",context),true,
   'deferred history recovery must remain pending');
 console.log('Visible polling resumes independently of deferred historical reset');
})().catch(e=>{console.error(e);process.exit(1)});
