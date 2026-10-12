// The coordinator must observe an accepted main-history page without waiting
// for its periodic fallback; removed charts must release their event demand.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function signal(){
 const handlers=new Set();return {subscribe(owner,fn){handlers.add(fn);},unsubscribe(owner,fn){handlers.delete(fn);},
  fire(){for(const fn of handlers)fn();},get count(){return handlers.size;}};
}
const loaded=signal(),loaded2=signal(),timers=[];
let mainReady=true;
let scope={generation:1,name:'LWMA',resolution:'5',first:1000,last:3000,count:3},revision=0,correctionVersion=0,withdrawals=0;
const handle={generation:1};let identity,coverage,reads=0,batches=[],liveCharts=[];
const study={id:'first'};
const chart={_chartWidget:{},symbol:()=> 'TEST',resolution:()=> '5',dataReady:()=>mainReady,getAllStudies:()=>[study],
 getStudyById:()=>({isVisible:()=>true,getInputValues:()=>[{id:'period',value:5}]}),onDataLoaded:()=>loaded};
const second={...chart,_chartWidget:{},getAllStudies:()=>[],onDataLoaded:()=>loaded2};liveCharts=[chart,second];
const widget={chartsCount:()=>liveCharts.length,chart:i=>liveCharts[i]};
const adapter={scope:()=>({...scope,coverage:coverage?{...coverage,generation:1}:null}),
 attach:(chart,id,next)=>{identity=next;return {...handle,identity:next};},detach:()=>{},
 applyBatch:async(h,batch)=>{batches.push(batch);coverage=batch.coverage;return true;},invalidate:async()=>{withdrawals++;coverage=null;return true;}};
const context={MWNativeIndicatorResults:adapter,queueMicrotask,Date,setInterval:fn=>{timers.push(fn);return fn;},clearInterval:()=>{}};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const coordinator=context.chartIndicatorCoordinator(widget,{LWMA:{params:{period:5},series:[{key:'value'}]}},{
 identity:{binding:()=>({inputRevision:revision,tailVersion:revision,correctionVersion}),chartTime:bar=>bar.start},
 read:async(ticker,res,args)=>{reads++;const bars=[0,1000,2000,3000].filter(t=>t<args.before).map(start=>({start,chart_time:start}));
 return {bars,cache_revision:0,has_more:false,indicators:[{name:'LWMA',params:{period:5},series:[{key:'value',values:bars.map(b=>({time:b.start,value:b.start/1000}))}]}]};}
});
async function settle(){for(let i=0;i<20;i++)await Promise.resolve();}
(async()=>{
 await coordinator.sync();assert.equal(reads,1);assert.equal(batches.length,1);
 scope={...scope,first:0,count:4};mainReady=false;loaded.fire();await settle();
 assert.equal(reads,1,'native reset must finish accepting main history before new indicator reads');
 mainReady=true;loaded.fire();loaded.fire();await settle();
 assert.equal(reads,2,'main-history completion starts indicator demand before fallback timer');
 assert.equal(batches.at(-1).kind,'prepend');assert.equal(batches.at(-1).coverage.first,0);
 assert.equal(loaded.count,1,'one subscription per native chart owner');
 await coordinator.sync();assert.equal(reads,2,'repeated sync retains accepted coverage');
 mainReady=false;correctionVersion++;await coordinator.sync();
 assert.equal(withdrawals,1,'real correction withdraws before main-history readiness');
 assert.equal(reads,2,'withdrawal does not start premature history demand');
 liveCharts=[chart];await coordinator.sync();assert.equal(loaded2.count,0,'removed chart releases subscription');
 loaded.fire();coordinator.dispose();await settle();assert.equal(loaded.count,0,'workspace disposal releases subscriptions');
 loaded.fire();await settle();assert.equal(reads,2,'disposed workspace cannot demand history');
 console.log('PASS main-history events: prompt prepend, deduplicated reads and chart/workspace cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
