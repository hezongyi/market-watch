// Actual recovery and native reload entry; the busy branch cannot start work.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('../advanced-host/bridge.js','utf8');
const reports=[],traces=[],chart={symbol:()=> 'MWP:XAUUSD',resolution:()=> '1D',dataReady:()=>false,
 getTimeScale:()=>({rightOffset:()=>0})};
let starts=0,onDeferred;
const ctx={emitNotice(){},crypto:require('node:crypto').webcrypto,ready:true,loading:false,
 console:{info:(label,evidence)=>{const entry=JSON.parse(evidence);traces.push(entry);
  if(entry.reload_phase==='deferred')onDeferred?.();}},
 historyReloading:true,rangeGuard:null,edgeGuard:null,barRangeMapping:null,
 refreshingHistoryRanges:new Map(),MWSeries:{same:(a,b)=>a===b},
 widget:{chartsCount:()=>1,chart:()=>chart},chartUsesSymbol:(c,s,r)=>c.symbol()===s&&c.resolution()===r,
 indicatorKey:(s,r)=>s+'|'+r,indicatorBindings:new Map([['MWP:XAUUSD|1D',{providerSnapshot:'expired'}]]),
 workspaceEpoch:1,compositeDisplayBatches:{cancel(){}},subscriptions:new Map(),marketGeneration:1,cache:new Map(),
 send:e=>reports.push(e),refreshChartHistory:async()=>{starts++;return true;},
 setTimeout:fn=>{queueMicrotask(fn);return 1;}};
vm.runInNewContext(source.slice(source.indexOf('function providerRecoveryRows('),source.indexOf('function acceptMarketHistory'))+
 source.slice(source.indexOf('async function reloadHistory('),source.indexOf('async function refreshManagedHistory('))+
 '\nglobalThis.run=()=>recoverDisplaySnapshot("MWP:XAUUSD","1D","expired");'+
 '\nglobalThis.reload=()=>reloadHistory("MWP:XAUUSD","1D",()=>true,true);'+
 '\nglobalThis.resume=()=>resumeDeferredDisplayRecoveries();',ctx);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const watchdog=setTimeout(()=>{console.error('FAIL recovery promise did not settle');process.exit(1);},10000);
(async()=>{
 let settled=false,error;
 const suspended=new Promise(resolve=>onDeferred=resolve);
 const pending=ctx.run().then(()=>settled=true,e=>{settled=true;error=e;});
 await suspended;
 assert.equal(settled,false,'busy waiting must not become a terminal error');
 assert.equal(starts,0);
 assert.equal(reports.some(e=>e.state==='error'),false);
 for(let i=0;i<8;i++){ctx.resume();await flush();}
 assert.equal(starts,0);assert.equal(settled,false,'busy lifecycle signals do not spend execution failures');
 ctx.historyReloading=false;ctx.resume();await pending;if(error)throw error;
 assert.equal(starts,1,'exactly one actual reload after the existing lifecycle releases busy');
 assert.equal(reports.filter(e=>e.state).at(-1).state,'ready');
 ctx.historyReloading=true;let cancelled=false;
 const suspendedAgain=new Promise(resolve=>onDeferred=resolve);
 const abandoned=ctx.run().then(()=>cancelled=true);await suspendedAgain;
 ctx.workspaceEpoch++;ctx.resume();await abandoned;
 assert.equal(cancelled,true);assert.equal(starts,1);
 assert.equal(reports.filter(e=>e.state==='error').length,0);
 assert(traces.some(e=>e.cancel_reason==='stale_native_generation'));
 assert.equal(traces.find(e=>e.reload_phase==='deferred').reload_starts,0);
 assert.equal(traces.some(e=>e.credential_ref==='expired'),false);
 ctx.historyReloading=false;
 ctx.MWNativeNavigation={busy:()=>false,interacting:()=>false,chartWindow:()=>({id:'accepted-window'}),
  refreshChartWindow:async()=>{ctx.workspaceEpoch++;return false;}};
 const stale=await ctx.reload();
 assert.equal(stale.status,'cancelled');assert.equal(stale.reason,'stale_native_generation');
 console.log('PASS native reload deferred without spending failures, then restored once');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
