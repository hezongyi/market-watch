const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={queueMicrotask,Date,setTimeout,setInterval:()=>1,clearInterval(){}};
const states=[],reports=[],reads=[];let fail='snapshot',recoverFails=true,recovered=0,token='s';
const scope={generation:1,name:'LWMA',resolution:'1',first:1000,last:2000,count:2};
const chart={symbol:()=> 'MWC:test',resolution:()=> '1',dataReady:()=>true,getAllStudies:()=>[{id:'study'}],
 getStudyById:()=>({getInputValues:()=>[{id:'period',value:5}]}),onDataLoaded:()=>({subscribe(){},unsubscribe(){}})};
context.MWNativeIndicatorResults={scope:()=>({...scope}),attach:(_,__,identity)=>({generation:1,identity}),detach(){},applyBatch:async()=>true};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const retry={['a'.repeat(64)]:'terminal-lease'};
const coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},{LWMA:{params:{period:5},series:[{key:'value'}]}},{
 identity:{binding:()=>({revision:'r',displaySnapshot:token,query:{display_snapshot_id:token}}),chartTime:b=>b.start},
 recover:async()=>{recovered++;if(recoverFails)throw Error('recovery busy');fail=null;},
 status:(_,state)=>states.push(state),report:e=>reports.push(e),
 read:async(_,__,args)=>{reads.push(args);if(fail)throw Object.assign(Error(fail),fail==='snapshot'?{code:'DISPLAY_SNAPSHOT_EXPIRED'}:{code:'DISPLAY_REPLAY_FAILED',display_retry:retry});
 return {bars:[{start:1000},{start:2000}],display_snapshot_id:token,has_more:false,
 indicators:[{name:'LWMA',params:{period:5},series:[{key:'value',values:[]}]}]};}
});
(async()=>{try{
 await coordinator.sync();assert.equal(states.at(-1),'error','recovery rejection must expose retry');
 await coordinator.sync();assert.equal(recovered,1,'no recovery storm');
 recoverFails=false;await coordinator.retry(0);assert.equal(recovered,2);await coordinator.sync();assert.equal(states.at(-1),'ready');
 fail='task';await coordinator.retry(0);assert.equal(states.at(-1),'error');
 const count=reads.length;await coordinator.sync();assert.equal(reads.length,count,'ordinary polling cannot restart terminal task');
 fail=null;await coordinator.retry(0);assert.deepEqual(JSON.parse(JSON.stringify(reads.at(-1).display_retry)),retry,'explicit retry forwards terminal credential');
 assert.equal(states.at(-1),'ready');
 fail='task';await coordinator.retry(0);token='new-snapshot';fail=null;
 await coordinator.retry(0);assert.equal(reads.at(-1).display_retry,undefined,'snapshot change discards old task credentials');
 console.log('PASS recovery failure status, bounded polling, explicit backend retry');
}finally{coordinator.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
