// PAIO shares the native result adapter's restart/credential/cleanup contract.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const calls=[],scope={generation:1,name:'PAIO_V1',resolution:'5',first:1000,last:2000,count:2};
const inputs={ma_1_use:true,ma_1_offset:2,ma_2_use:true,ma_2_offset:-1,ma_3_use:true,ma_3_offset:0,pvLineDraw:true,pv1stUse:true,pv2ndUse:true,pv3rdUse:true};
const chart={symbol:()=> 'MWC:test',resolution:()=> '5',dataReady:()=>true,getAllStudies:()=>[{id:'study'}],getStudyById:()=>({getInputValues:()=>Object.entries(inputs).map(([id,value])=>({id,value}))}),onDataLoaded:()=>({subscribe(){},unsubscribe(){}})};
const ctx={crypto:require('node:crypto').webcrypto,queueMicrotask,Date,setTimeout,setInterval:()=>1,clearInterval(){},
 MWNativeIndicatorResults:{scope:()=>({...scope}),attach:(_,__,identity)=>({identity}),detach(){},applyBatch:async(_,batch)=>{calls.push(batch);return true;},invalidate:async()=>true}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),ctx);
const catalog={PAIO_V1:{version:'1',render_profile:'paio_v1',params:inputs,series:['ema_1','ema_2','ema_3','pv_1','pv_2','pv_3'].map(key=>({key,type:'line'}))}};
const drawings={needsSnapshot:()=>true,refresh(){},clear(){},update(){},dispose(){}};
const coordinator=ctx.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},catalog,{drawings,
 identity:{binding:()=>({revision:'fixture',inputRevision:1}),chartTime:b=>b.start},report:e=>{throw e;},
 read:async()=>({bars:[{start:1000},{start:2000}],has_more:false,indicators:[{name:'PAIO_V1',params:inputs,series:catalog.PAIO_V1.series.map(s=>({...s,values:[{time:1000,value:1},{time:2000,value:2}]})),presentation:{schema:'paio_presentation_v1',objects:[]}}]})});
(async()=>{try{
 await coordinator.sync();assert.equal(calls.length,1);assert.equal(calls[0].offsets.plot0,2);assert.equal(calls[0].offsets.plot1,-1);
 assert.equal(calls[0].rows[0].values.length,6);assert.equal(calls[0].rows[0].values[3],null,'PV plots hidden in line drawing mode');
 scope.generation++;await coordinator.sync();assert.equal(calls.length,2,'restarted native generation gets a fresh full snapshot');
 console.log('PASS PAIO native restart keeps six plot identities, offsets and visibility');
}finally{coordinator.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
