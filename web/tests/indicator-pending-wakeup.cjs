const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let clock=1000,pending=true,reads=0,accepted=0,removed=false;
const timers=new Map(),states=[],reports=[];
class Clock extends Date{static now(){return clock;}}
const chart={symbol:()=> 'TEST',resolution:()=> '1',dataReady:()=>true,
  onDataLoaded:()=>({subscribe(){},unsubscribe(){}}),getAllStudies:()=>removed?[]:[{id:'a'}],
  getStudyById:()=>({getInputValues:()=>[{id:'period',value:5}]})};
const context={MWNativeIndicatorResults:{scope:()=>({generation:1,name:'LWMA',resolution:'1',first:1,last:2,count:2}),
  attach:(chart,id,identity)=>({generation:1,identity}),applyBatch:async()=>{accepted++;return true;},detach(){}},
  queueMicrotask,Date:Clock,setInterval:()=>1,clearInterval(){},setTimeout:(fn,ms)=>{timers.set(fn,ms);return fn;},clearTimeout:fn=>timers.delete(fn)};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},
  {LWMA:{params:{period:5},series:[{key:'value'}]}},{
    identity:{binding:()=>({revision:'1',inputRevision:1}),chartTime:bar=>bar.start},
    status:(consumer,state)=>states.push(state),report:error=>reports.push(error),
    read:async()=>{reads++;return {bars:[{start:1},{start:2}],has_more:false,
      indicators:[{name:'LWMA',params:{period:5},calculation:{status:pending?'pending':'complete'},
        series:[{key:'value',values:[{time:1,value:1},{time:2,value:2}]}]}]};}});
(async()=>{
  await coordinator.sync();assert.equal(accepted,0);assert.equal(timers.size,1);
  const [wake,delay]=[...timers][0];assert.equal(delay,50);
  pending=false;clock+=delay;timers.delete(wake);wake();
  for(let i=0;i<50;i++)await Promise.resolve();
  assert.equal(reads,2);assert.equal(accepted,1,'worker completion must render before the safety poll');
  pending=true;await coordinator.retry(0);assert.equal(timers.size,1);
  clock+=30001;await coordinator.sync();
  assert.equal(states.at(-1),'error');assert.equal(reports.at(-1).code,'INDICATOR_TIMEOUT');
  const count=reads;await coordinator.sync();assert.equal(reads,count,'timeout waits for explicit retry');
  pending=false;await coordinator.retry(0);assert.equal(states.at(-1),'ready','explicit retry resets the wait deadline');
  pending=true;await coordinator.retry(0);removed=true;await coordinator.sync();
  assert.equal(timers.size,0,'deletion clears the scheduled retry');coordinator.dispose();
  console.log('PASS prompt pending wakeup, 30-second deadline, explicit retry and timer cleanup');
})().catch(error=>{console.error(error);coordinator.dispose();process.exitCode=1;});
