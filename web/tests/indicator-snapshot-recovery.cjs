const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={queueMicrotask,Date,setTimeout,setInterval:()=>1,clearInterval(){}};
const errors=[],recovered=[],batches=[];let token='expired',fail=true;
const scope={generation:1,name:'LWMA',resolution:'1',first:1000,last:2000,count:2};
const chart={symbol:()=> 'MWC:test',resolution:()=> '1',dataReady:()=>true,getAllStudies:()=>[{id:'study'}],
 getStudyById:()=>({getInputValues:()=>[{id:'period',value:5}]}),onDataLoaded:()=>({subscribe(){},unsubscribe(){}})};
context.MWNativeIndicatorResults={scope:()=>({...scope}),attach:(_,__,identity)=>({generation:1,identity}),detach(){},
 applyBatch:async(_,batch)=>{assert.ok(batch.current());batches.push(batch);return true;},invalidate:async()=>true};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},{LWMA:{params:{period:5},series:[{key:'value'}]}},{
 identity:{binding:()=>({revision:'composite',inputRevision:1,tailVersion:token,displaySnapshot:token,query:{display_snapshot_id:token}}),chartTime:b=>b.start},
 recover:async(ticker,res,credential)=>{recovered.push({ticker,res,credential});token='fresh';fail=false;},report:e=>errors.push(e),
 read:async(_,__,args)=>{if(fail)throw Object.assign(Error('expired'),{code:'DISPLAY_SNAPSHOT_EXPIRED'});
 const bars=[{start:1000},{start:2000}];return {bars,input_revision:1,display_snapshot_id:args.display_snapshot_id,has_more:false,
 indicators:[{name:'LWMA',params:{period:5},series:[{key:'value',values:bars.map(b=>({time:b.start,value:1}))}]}]};}
});
(async()=>{try{
 await coordinator.sync();assert.equal(recovered.length,1);assert.equal(batches.length,0);
 assert.equal(recovered[0].credential,'expired');
 await coordinator.sync();assert.equal(batches.length,1);assert.equal(batches[0].displaySnapshot,'fresh');assert.equal(errors.length,0);
 console.log('PASS expired credential recovers parent prices before accepting new study results');
}finally{coordinator.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
