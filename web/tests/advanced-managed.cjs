const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const events=[];
const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>events.push(m)},
 crypto:{randomUUID:()=> 'test'},atob:s=>Buffer.from(s,'base64').toString('utf8'),btoa:s=>Buffer.from(s).toString('base64'),
 addEventListener(){},setTimeout,clearTimeout});
for(const file of ['series.js','chart-runtime.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
(async()=>{
 await vm.runInContext(`(async()=>{
  globalThis.calls=[];globalThis.currentReady=false;
  const chart={symbol:()=> 'EURUSD',resolution:()=> '5',getTimeScale:()=>({width:()=>960,barSpacing:()=>6})};
  widget={chartsCount:()=>1,chart:()=>chart};
  request=async(q,type)=>{
   calls.push({q,type});
   if(q.op==='dataset')return {ready:currentReady,reason:currentReady?'ready':'unmaintained',start:100000,revision:1};
   if(q.op)throw Error('chart must never schedule acquisition');
   return {bars:[{start:100000,end:400000,open:1,high:2,low:1,close:2}],indicators:[],has_more:false};
  };
  const params={to:1000,countBack:160,firstDataRequest:true};
  const callback=(bars,meta)=>{globalThis.page={bars,meta}};
  await feed.getBars({ticker:'EURUSD'},'5',params,callback,e=>{throw Error(e)});
  await feed.getBars({ticker:'EURUSD'},'5',params,callback,e=>{throw Error(e)});
 })()`,ctx);
 assert.equal(events.filter(e=>e.type==='maintenance-required').length,1);
 assert.equal(ctx.page.bars.length,0);assert.equal(ctx.page.meta.noData,true);
 await vm.runInContext(`(async()=>{
  currentReady=true;
  await feed.getBars({ticker:'EURUSD'},'5',{to:1000,countBack:160,firstDataRequest:true},
   (bars,meta)=>{globalThis.page={bars,meta}},e=>{throw Error(e)});
 })()`,ctx);
 assert.equal(ctx.page.bars.length,1);
 const calls=vm.runInContext('calls',ctx);
 assert.equal(calls[0].q.args.plot_width,960);assert.equal(calls[0].q.args.bar_spacing,6);
 assert.equal(calls.at(-1).q.published,true);assert.equal(calls.at(-1).q.dataset_start,100000);
 assert.ok(calls.every(c=>!c.q.op||c.q.op==='dataset'));
 await vm.runInContext(`(async()=>{
  ready=true;
  rangeGuard={busy:()=>true};
  await refreshManagedHistory('EURUSD');
 })()`,ctx);
 assert.equal(vm.runInContext("managedSessions.get('EURUSD|5')?.start",ctx),100000,
  'a deferred explicit refresh must retain the current session for realtime updates');
 console.log('Managed feed: consent, refusal, real geometry, published session boundary passed');
})().catch(e=>{console.error(e);process.exitCode=1});
