// Replay actual market MessageEvents against the coordinator with delayed reads.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const provider=process.argv.includes('--provider');
const credential=provider?'provider_snapshot_id':'display_snapshot_id';
const bridge=fs.readFileSync('../advanced-host/chart-runtime.js','utf8');
const callbacks=[],batches=[],reads=[],held=[],reports=[];
let token,scope={generation:1,name:'LWMA',resolution:'1',first:60000,last:60000,count:1},coordinator;
const sub={symbol:'MWC:test',res:'1',last:0,marketListener:'listener',marketGeneration:1,marketSequence:0,
 cb:bar=>{callbacks.push(bar);scope={...scope,last:bar.time,count:callbacks.filter((v,i,a)=>a.findIndex(b=>b.time===v.time)===i).length};}};
const subscriptions=new Map([['native',sub]]),bindings=new Map(),state=new Map([['MWC:test|1|',{}]]);
const chart={symbol:()=>sub.symbol,resolution:()=>sub.res,dataReady:()=>true,getAllStudies:()=>[{id:'study'}],
 getStudyById:()=>({isVisible:()=>true,getInputValues:()=>[{id:'period',value:5}]}),onDataLoaded:()=>({subscribe(){},unsubscribe(){}})};
const adapter={scope:()=>({...scope}),attach:(_,__,identity)=>({generation:1,identity}),detach(){},invalidate:async()=>true,
 applyBatch:async(_,batch)=>{if(!batch.current())return false;batches.push(batch);return true;}};
const context={crypto:require('node:crypto').webcrypto,MWNativeIndicatorResults:adapter,queueMicrotask,Date,setTimeout,clearTimeout,
 setInterval:()=>1,clearInterval(){},addEventListener:(type,handler)=>{if(type==='message')context.handle=handler;},
 disposed:false,send:()=>{},parent:{},parentOrigin:'https://parent.test',ready:false,loading:false,
 quoteSubscriptions:new Map(),subscriptions,marketHistoryState:state,indicatorBindings:bindings,
 indicatorKey:(s,r)=>s+'|'+r,decode:()=>({symbol:'test',series_kind:provider?'provider':'composite'}),
 stamp:bar=>bar.start,barsOf:event=>event.bars.map(bar=>({...bar,time:bar.start})),observeRangeBars(){},
 rememberIndicatorBinding:(s,r,event)=>{token=event[credential];bindings.set(s+'|'+r,{displaySnapshot:token});void coordinator.sync();}};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},
 {LWMA:{params:{period:5},series:[{key:'value'}]}},{
 identity:{binding:()=>token?{revision:'composite',inputRevision:1,tailVersion:token,correctionVersion:0,
  ...(provider?{providerSnapshot:token}:{displaySnapshot:token}),query:{[credential]:token}}:null,chartTime:bar=>bar.start},
 read:async(_,__,args)=>{reads.push(args[credential]);await new Promise(resolve=>held.push(resolve));
  const bars=Array.from({length:scope.count},(_,i)=>({start:60000*(i+1)}));
  return {bars,input_revision:1,[credential]:args[credential],has_more:false,
   indicators:[{name:'LWMA',params:{period:5},series:[{key:'value',values:bars.map(bar=>({time:bar.start,value:10}))}]}]};}
 });
if(fs.existsSync('../advanced-host/composite-display-batches.js')){
 vm.runInNewContext(fs.readFileSync('../advanced-host/composite-display-batches.js','utf8'),context);
 context.compositeDisplayBatches=context.chartDisplayBatches({
  accept:(entry,event)=>context.acceptMarketBars(entry,event),
  settle:(key,current)=>coordinator.settle((s,r)=>s+'|'+r===key,current),report:(key,error)=>reports.push(error),maxWait:1000});
 const a=bridge.indexOf('function acceptMarketBars('),b=bridge.indexOf('\nfunction ',a+1);
 assert.ok(a>=0 && b>a,'test must execute actual price acceptance helper');
 vm.runInNewContext(bridge.slice(a,b),context);
}
const start=bridge.indexOf('async function update(m) {');
const end=bridge.indexOf('\nfunction disposeChart()',start);
vm.runInNewContext(bridge.slice(start,end),context);
async function flush(){for(let i=0;i<40;i++)await Promise.resolve();}
async function event(sequence,minute,close=sequence){await context.update({type:'market-event',event:{listener:'listener',generation:1,sequence,type:'bars',
 [credential]:'snapshot-'+sequence,initial_input_revision:1,bars:[{start:minute*60000,open:1,high:close,low:1,close}]}});await flush();}
(async()=>{
 try{
  await event(1,1);assert.deepEqual(reads,['snapshot-1']);
  for(let i=2;i<=100;i++)await event(i,1);
  await event(101,2);await event(102,3);await event(103,3,104);
  assert.equal(token,'snapshot-1','later prices must coalesce while the accepted snapshot is calculating');
  assert.equal(callbacks.length,1,'quote burst cannot advance the parent before its current batch settles');
  held.shift()();await flush();
  assert.equal(batches.length,1,'a slow exact read must make progress under continuing quotes');
  assert.equal(batches[0].displaySnapshot,'snapshot-1');
  assert.equal(token,'snapshot-103');assert.deepEqual(callbacks.map(bar=>bar.time),[60000,60000,120000,180000]);
  assert.equal(callbacks.at(-1).close,104);assert.deepEqual(reads,['snapshot-1','snapshot-103']);
  held.shift()();await flush();assert.equal(batches.length,2);assert.equal(batches[1].displaySnapshot,token);
  assert.equal(reports.filter(Boolean).length,0);
  console.log('PASS '+(provider?'provider':'composite')+' actual bridge/coordinator: quote burst coalescing, slow-read progress and cross-minute retention');
 }finally{context.compositeDisplayBatches?.dispose();coordinator.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
