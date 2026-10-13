// Parent prices and Python results must share one exact display credential.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const batches=[],requests=[];
let token='accepted-7',responseToken='newer-8';
const scope={generation:1,name:'LWMA',resolution:'1',first:1000,last:3000,count:3};
const chart={symbol:()=> 'TEST',resolution:()=> '1',dataReady:()=>true,getAllStudies:()=>[{id:'study'}],
 getStudyById:()=>({isVisible:()=>true,getInputValues:()=>[{id:'period',value:5}]}),
 onDataLoaded:()=>({subscribe(){},unsubscribe(){}})};
const adapter={scope:()=>({...scope}),attach:(_,__,identity)=>({generation:1,identity}),detach(){},invalidate:async()=>true,
 applyBatch:async(_,batch)=>{assert.equal(batch.current(),true);batches.push(batch);return true;}};
const context={MWNativeIndicatorResults:adapter,queueMicrotask,Date,setInterval:()=>1,clearInterval(){}};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},
 {LWMA:{params:{period:5},series:[{key:'value'}]}},{
 identity:{binding:()=>({revision:'composite',inputRevision:1,tailVersion:7,correctionVersion:0,
  displaySnapshot:token,query:{display_snapshot_id:token}}),chartTime:bar=>bar.start},
 read:async(_,__,args)=>{requests.push(args);const bars=[1000,2000,3000].map(start=>({start}));
  return {bars,input_revision:1,display_snapshot_id:responseToken,has_more:false,
   indicators:[{name:'LWMA',params:{period:5},calculation:{status:'pending',display_status:'complete'},
    series:[{key:'value',values:bars.map(bar=>({time:bar.start,value:10}))}]}]};}
 });
(async()=>{
 try{
  await coordinator.sync();assert.equal(batches.length,0,'newer HTTP input cannot attach to older parent prices');
  assert.equal(requests[0].display_snapshot_id,'accepted-7');
  responseToken=token;await coordinator.sync();assert.equal(batches.length,1,'display suffix can serve while fixed job is pending');
  token='accepted-9';assert.equal(batches[0].current(),false,'queued commit must reject a superseded parent snapshot');
  responseToken=token;await coordinator.sync();assert.equal(batches.length,2);
  console.log('PASS exact display snapshot, display readiness and queued acceptance fencing');
 }finally{coordinator.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
