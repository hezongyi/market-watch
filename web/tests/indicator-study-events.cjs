// A newly ready native study must not wait for the 500ms safety poll.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let nativeChanged,reads=0,removed=false;const listeners=new Map(),states=[];
const chart={symbol:()=> 'TEST',resolution:()=> '1',dataReady:()=>true,
  onDataLoaded:()=>({subscribe(){},unsubscribe(){}}),getAllStudies:()=>removed?[]:[{id:'a'}],
  getStudyById:()=>({getInputValues:()=>[{id:'period',value:5}]})};
const adapter={subscribe:fn=>{nativeChanged=fn;return ()=>nativeChanged=null;},
  scope:()=>({generation:1,name:'LWMA',resolution:'1',first:1,last:2,count:2}),
  attach:(c,id,identity)=>({generation:1,identity}),applyBatch:async()=>true,detach(){}};
const widget={chartsCount:()=>1,chart:()=>chart,
  subscribe:(name,fn)=>listeners.set(name,fn),unsubscribe:(name,fn)=>{assert.equal(listeners.get(name),fn);listeners.delete(name);}};
const context={MWNativeIndicatorResults:adapter,queueMicrotask,Date,setInterval:()=>1,clearInterval(){}};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const coordinator=context.chartIndicatorCoordinator(widget,{LWMA:{params:{period:5},series:[{key:'value'}]}},{
  identity:{binding:()=>({revision:'1',inputRevision:1}),chartTime:bar=>bar.start},status:(c,state)=>states.push(state),
  read:async()=>{reads++;return {bars:[{start:1},{start:2}],has_more:false,
    indicators:[{name:'LWMA',params:{period:5},series:[{key:'value',values:[{time:1,value:0},{time:2,value:-1}]}]}]};}});
(async()=>{
  assert.equal(typeof nativeChanged,'function','native adapter readiness must wake the coordinator');
  nativeChanged();nativeChanged();for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(reads,1,'coalesce native starts without polling');assert.ok(states.includes('ready'));
  removed=true;listeners.get('study_event')('a','remove');for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(coordinator.diagnostics().consumers,0,'delete immediately releases demand');
  coordinator.dispose();assert.equal(nativeChanged,null);assert.equal(listeners.size,0);
  console.log('PASS study readiness and deletion before periodic fallback, with subscription cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
