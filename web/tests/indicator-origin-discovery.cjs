// The first provider response can establish origin without losing that result.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let generation=1,attachedOrigin,accepted=0,reads=0;
const chart={symbol:()=> 'TEST',resolution:()=> '1',dataReady:()=>true,
  onDataLoaded:()=>({subscribe(){},unsubscribe(){}}),getAllStudies:()=>[{id:'a'}],
  getStudyById:()=>({getInputValues:()=>[{id:'period',value:5}]})};
const adapter={scope:()=>({generation,name:'LWMA',resolution:'1',first:10,last:20,count:2}),
  attach:(chart,id,identity)=>{if(attachedOrigin!==identity.calculationStart){attachedOrigin=identity.calculationStart;generation++;}return {generation,identity};},
  applyBatch:async(handle,batch)=>{assert.equal(handle.generation,generation);assert.ok(batch.current(),'first accepted read must survive origin discovery');accepted++;return true;},detach(){}};
const context={MWNativeIndicatorResults:adapter,queueMicrotask,Date,setInterval:()=>1,clearInterval(){}};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},
  {LWMA:{params:{period:5},series:[{key:'value'}]}},{
    identity:{binding:()=>({revision:'1',inputRevision:1}),chartTime:bar=>bar.start},
    read:async()=>{reads++;return {calculation_origin:1,bars:[{start:10},{start:20}],has_more:false,
      indicators:[{name:'LWMA',params:{period:5},series:[{key:'value',values:[{time:10,value:5},{time:20,value:6}]}]}]};}});
(async()=>{
  await coordinator.settle(()=>true);
  assert.equal(reads,1);assert.equal(accepted,1,'origin discovery must not wait for another polling pass');
  assert.equal(attachedOrigin,1);coordinator.dispose();
  console.log('PASS first provider origin discovery accepts the same read under the new generation');
})().catch(error=>{console.error(error);process.exitCode=1;});
