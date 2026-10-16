const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const messages=[],handlers=[];
const ctx=vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},URL,URLSearchParams,Map,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>messages.push(m)},
 crypto:{randomUUID:()=> 'startup'},addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn)},setTimeout,clearTimeout});
for(const file of ['series.js','composite-display-batches.js','bridge.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
messages.length=0;
(async()=>{
 vm.runInContext(`initialSymbol={ticker:'MWP:BTCUSDT',metadata:{name:'BTCUSDT',basis:'last',
 source:'binance',precision:2,calendar:'utc0'}};globalThis.resolved=[];
 globalThis.first=feed.resolveSymbol('MWP:BTCUSDT',info=>resolved.push(info),error=>{throw error});`,ctx);
 assert.equal(messages.length,0,'startup metadata avoids another cross-origin resolve request');
 assert.equal(ctx.resolved.length,0,'supplied metadata still invokes the native callback asynchronously');
 await ctx.first;
 assert.equal(ctx.resolved[0].ticker,'MWP:BTCUSDT');assert.equal(ctx.resolved[0].pricescale,100);
 // It is a one-time transport payload, never a symbol/business cache.
 vm.runInContext(`globalThis.second=feed.resolveSymbol('MWP:BTCUSDT',info=>resolved.push(info),error=>{throw error});`,ctx);
 const sent=messages[0];assert.equal(sent.query.op,'resolve');assert.equal(sent.query.args.series_kind,'provider');
 await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'result',id:sent.id,
      result:{name:'BTCUSDT',basis:'last',source:'binance',precision:3,calendar:'utc0'}}});
 await ctx.second;assert.equal(ctx.resolved[1].pricescale,1000,'later resolves use current backend metadata');
 vm.runInContext(`initialSymbol={ticker:'MWP:BTCUSDT',metadata:{name:'startup provider',basis:'last',source:'binance',precision:2,calendar:'utc0'}};
 globalThis.managed=feed.resolveSymbol('BTCUSDT',info=>resolved.push(info),error=>{throw error});`,ctx);
 const managed=messages[1];assert.equal(managed.query.args.series_kind,'managed');
 assert.equal(vm.runInContext('initialSymbol.ticker',ctx),'MWP:BTCUSDT',
  'an unrelated watchlist resolve must not consume the initial chart metadata');
 await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'result',id:managed.id,
  result:{name:'BTC managed',basis:'last',source:'binance',precision:2,calendar:'utc0'}}});
 await ctx.managed;assert.equal(ctx.resolved[2].ticker,'BTCUSDT');
 vm.runInContext(`globalThis.matched=feed.resolveSymbol('MWP:BTCUSDT',info=>resolved.push(info),error=>{throw error});`,ctx);
 await ctx.matched;
 assert.equal(vm.runInContext('initialSymbol',ctx),undefined,'matching startup metadata is still consumed once');
 assert.equal(ctx.resolved[3].ticker,'MWP:BTCUSDT');
 console.log('Startup metadata is consumed once, preserves series identity and does not acquire bars');
})().catch(error=>{for(const entry of vm.runInContext('[...pending.values()]',ctx)){clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer)}console.error(error);process.exitCode=1});
