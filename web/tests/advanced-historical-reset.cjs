const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers=[],messages=[];
const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>messages.push(m)},
 crypto:{randomUUID:()=> 'listener'},addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn)},setTimeout,clearTimeout});
for(const f of ['series.js','bridge.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+f,'utf8'),ctx);
(async()=>{
 vm.runInContext(`globalThis.reloads=0;globalThis.reviews=[];globalThis.changed=false;globalThis.available=true;globalThis.active=true;
  ready=true;const chart={resolution:()=> '5',symbol:()=> 'MWP:BTCUSDT',getAllStudies:()=>[]};
  widget={chartsCount:()=>1,chart:()=>chart,activeChart:()=>chart};
  globalThis.MWNativeNavigation={chartWindow:()=>({id:'historical'}),hasWindow:()=>active};
  reloadHistory=async()=>{reloads++;return true};
  query=async(symbol,res,args)=>{reviews.push(args);if(!available)throw Error('temporary failure');if(globalThis.delay)await delay;return {cache_revision:20,as_of:2000,history_revalidation:{changed},bars:[]}};
  providerHistoryWork.set('MWP:BTCUSDT|5|historical',{symbol:'MWP:BTCUSDT',res:'5',window:'historical',observation:{first:100000,last:200000,observed_at:1000,revision:10}});
  subscriptions.set('native',{providerListener:'listener',symbol:'MWP:BTCUSDT',res:'5',window:'historical',historical:true});`,ctx);
 const reset=(revision=11)=>handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'provider-event',event:{type:'reset',listener:'listener',revision,as_of:1100,cursor:9000000}}});
 await reset();
 assert.equal(ctx.reloads,0,'far-away latest rows must not rebuild an unchanged historical window');
 assert.equal(ctx.reviews.length,1);assert.equal(ctx.reviews[0].history_observation.first,100000);
 assert.equal(ctx.reviews[0].history_observation.last,200000);
 await reset();assert.equal(ctx.reloads,0);assert.equal(ctx.reviews.length,1,'already verified revision does not repeat review');
 vm.runInContext('changed=true',ctx);await reset(21);assert.equal(ctx.reloads,1,'confirmed historical revision still reloads');
 vm.runInContext('changed=false;available=false',ctx);await reset(22);assert.equal(ctx.reloads,1,'failed review cannot clear or rebuild valid bars');
 vm.runInContext('available=true;globalThis.delay=new Promise(ok=>globalThis.release=ok)',ctx);
 const a=reset(23),b=reset(24);await new Promise(ok=>setImmediate(ok));
 assert.equal(ctx.reviews.length,4,'overlapping reset events share one check');
 vm.runInContext('active=false;release()',ctx);await Promise.all([a,b]);assert.equal(ctx.reloads,1,'obsolete historical check cannot reload another window');
 console.log('Historical reset: latest gaps, real corrections, failures, coalescing and obsolete windows passed');
})().catch(e=>{console.error(e);process.exitCode=1});
