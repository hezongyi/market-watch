const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const messages=[],handlers=[];
const ctx=vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},URL,URLSearchParams,Map,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>messages.push(m)},
 crypto:{randomUUID:()=> 'test'},addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn)},setTimeout,clearTimeout,
 requestAnimationFrame:callback=>setImmediate(callback)});
for(const f of ['series.js','composite-display-batches.js','bridge.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+f,'utf8'),ctx);
(async()=>{
 vm.runInContext(`globalThis.delivered=[];globalThis.failures=[];
  let resolution='1W';ready=true;
  widget={chartsCount:()=>1,chart:()=>({resolution:()=>resolution,symbol:()=> 'MWP:BTCUSDT',getAllStudies:()=>[]})};
  globalThis.a=feed.getBars({ticker:'MWP:BTCUSDT'},'1W',{from:1,to:100,countBack:1},
    bars=>delivered.push('week'),error=>failures.push(error));
  resolution='1';
  globalThis.b=feed.getBars({ticker:'MWP:BTCUSDT'},'1',{from:1,to:100,countBack:1},
    bars=>delivered.push('minute'),error=>failures.push(error));
  resolution='1W';`,ctx);
 await new Promise(resolve=>setTimeout(resolve,160));
 assert.equal(messages.filter(m=>m.type==='cancel-request').length,0,
   'native cached period requests remain valid while another period is selected');
 for(const sent of messages.filter(m=>m.type==='data')){
  await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'result',id:sent.id,
   result:{bars:[{start:1000,chart_time:1000,end:2000,open:1,high:2,low:0,close:1,complete:true}],history_boundary:false}}});
 }
 await Promise.all([ctx.a,ctx.b]);
 assert.equal(ctx.delivered.length,2);assert.equal(ctx.failures.length,0);
 vm.runInContext(`globalThis.c=query('MWP:BTCUSDT','1',{limit:1}).catch(error=>error.code);workspaceEpoch++;`,ctx);
 await new Promise(resolve=>setTimeout(resolve,160));
 assert.equal(await ctx.c,'HISTORY_CANCELLED','changing workspace still releases obsolete requests');
 vm.runInContext(`globalThis.expired=query('MWP:BTCUSDT','1',{limit:1},Date.now()-1).catch(error=>error.code);`,ctx);
 assert.equal(await ctx.expired,'HISTORY_TIMEOUT','expired history budget retains a structured timeout code');
 console.log('Provider native requests survive period switches and cancel on workspace replacement');
})().catch(error=>{for(const entry of vm.runInContext('[...pending.values()]',ctx)){clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer)}console.error(error);process.exitCode=1});
