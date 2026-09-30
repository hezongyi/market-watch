const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const context=vm.createContext({Promise,Date,setTimeout});
vm.runInContext(fs.readFileSync('../advanced-host/history-demand.js','utf8'),context);
(async()=>{
 let reads=0,waits=0,active=true;
 const submit=async()=>({window_start:10,window_end:30,status:'pending'});
 const check=()=>{if(!active)throw Error('cancelled')};
 const page=await context.historicalNavigationPage(submit,async before=>{
  assert.equal(before,30);reads++;return {bars:reads===1?[{start:20}]:[{start:10},{start:20}]};
 },check,()=>{},async()=>{waits++});
 assert.equal(reads,2);assert.equal(waits,1);assert.equal(page.bars[0].start,10);
 await assert.rejects(context.historicalNavigationPage(submit,async()=>({bars:[]}),check,()=>{},async()=>{active=false}),/cancelled/);
 active=true;
 await assert.rejects(context.historicalNavigationPage(async()=>({status:'cancelled'}),()=>{throw Error('must not read')},check,()=>{}),/已取消/);
 await assert.rejects(context.historicalNavigationPage(async()=>({window_start:1,window_end:2,window_error:'retry history'}),async()=>({bars:[]}),check,()=>{}),/retry history/);
 console.log('Historical navigation waits for target coverage and yields to cancellation');
})().catch(e=>{console.error(e);process.exit(1)});
