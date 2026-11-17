const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').resolve(__dirname,'../../advanced-host/chart-runtime.js'),'utf8');
const drain=source.slice(source.indexOf('function drain() {'),source.indexOf('function request(',source.indexOf('function drain() {')));
test('price mutations allow complete controller/readback budget and remain unknown on outer timeout',()=>{
 for(const op of ['price_create','price_edit','price_action']){
  const timers=[],failures=[];
  const selected={type:'chart-alert-rpc',query:{op},resolve(){},reject:e=>failures.push(e)};
  const context={requests:[selected],pending:new Map(),seq:0,adapter:{},globalThis:{},discardObsoleteRequests(){},requestPolicy:{next:()=>0,describe:()=>({}),dispatched(){}},setTimeout:(fn,ms)=>{timers.push({fn,ms});},application:{alerts:()=>new Promise(()=>{}),cancel(){}},completeRequest(){}};
  vm.runInNewContext(drain+';drain();',context);
  assert.equal(timers[0].ms,75000);timers[0].fn();assert.equal(failures[0].outcomeUnknown,true);assert.equal(failures[0].code,'ALERT_OUTCOME_UNKNOWN');
 }
});
