const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const bridge=fs.readFileSync('../advanced-host/bridge.js','utf8');
const start=bridge.indexOf('const displayRecoveries=new Map();'),end=bridge.indexOf('function acceptMarketHistory',start);
let busy=true,attempts=0,registered=0,onReload,ticker='MWC:test';
const reports=[],chart={symbol:()=> ticker,resolution:()=> '1'},sub={symbol:'MWC:test',res:'1'};
const ctx={ready:true,widget:{chartsCount:()=>1,chart:()=>chart},chartUsesSymbol:(c,s,r)=>c.symbol()===s&&c.resolution()===r,
 indicatorKey:(s,r)=>s+'|'+r,indicatorBindings:new Map([['MWC:test|1',{displaySnapshot:'expired'}]]),workspaceEpoch:1,compositeDisplayBatches:{cancel(){}},subscriptions:new Map([['sub',sub]]),marketGeneration:1,cache:new Map(),
 reloadHistory:async()=>{attempts++;onReload?.();return !busy;},registerMarketBar(){registered++;},send:x=>reports.push(x),setTimeout:fn=>{queueMicrotask(fn);return 1;}};
vm.runInNewContext(bridge.slice(start,end)+'\nglobalThis.recover=recoverDisplaySnapshot;globalThis.prune=()=>{for(const entry of displayRecoveries.values())entry.prune();};',ctx);
(async()=>{
 await assert.rejects(ctx.recover('MWC:test','1','expired'),/恢复失败/);
 assert.equal(reports.filter(x=>x.state==='error').length,1,'price-only chart exposes retry');
 assert.equal(attempts,3);assert.equal(sub.needsHistoryReload,true);
 busy=false;await assert.rejects(ctx.recover('MWC:test','1','expired'));assert.equal(attempts,3,'ordinary poll remains bounded');
 await ctx.recover('MWC:test','1','expired',true);assert.equal(attempts,4);assert.equal(sub.needsHistoryReload,false);assert.equal(registered,1);
 assert.equal(reports.filter(x=>x.state).at(-1).state,'ready');
 // A fresh price read can renew the same content-addressed credential. If it
 // expires again later, its completed recovery must not suppress a new read.
 await ctx.recover('MWC:test','1','expired');assert.equal(attempts,5);assert.equal(registered,2);
 // A delayed error for an old token must still leave newer prices alone.
 ctx.indicatorBindings.get('MWC:test|1').displaySnapshot='fresh';
 await ctx.recover('MWC:test','1','expired');assert.equal(attempts,5);assert.equal(registered,2);
 busy=true;await assert.rejects(ctx.recover('MWC:test','1','navigation'));
 ticker='MWC:other';ctx.prune();assert.equal(reports.filter(x=>x.state).at(-1).state,'removed','settled error removed after symbol switch');
 ticker='MWC:test';busy=false;
 onReload=()=>{ctx.workspaceEpoch++;};await ctx.recover('MWC:test','1','new');
 assert.equal(registered,2,'old workspace cannot re-register a subscription');
 console.log('PASS price-only retry, recovery deduplication, workspace cancellation');
})().catch(e=>{console.error(e);process.exitCode=1;});
