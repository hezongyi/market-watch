const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const messages=[],handlers=[];
 const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
  location:{search:'?parent=http://localhost'},parent:{postMessage:m=>messages.push(m)},
  crypto:{randomUUID:()=> 'listener'},addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn)},setTimeout,clearTimeout});
 for(const f of ['series.js','bridge.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+f,'utf8'),ctx);
 vm.runInContext(`globalThis.delivered=[];globalThis.failures=[];globalThis.reloads=0;
  ready=true;globalThis.currentRes='5';
  const chart={resolution:()=>currentRes,symbol:()=> 'MWP:BTCUSDT',getAllStudies:()=>[]};
  widget={chartsCount:()=>1,chart:()=>chart,activeChart:()=>chart};
  reloadHistory=async()=>{reloads++;return true;};`,ctx);
 const begin=(name,from,to)=>vm.runInContext(`globalThis.${name}=feed.getBars({ticker:'MWP:BTCUSDT'},'5',
  {from:${from},to:${to},countBack:2,firstDataRequest:false},
  rows=>delivered.push({name:'${name}',rows}),error=>failures.push(error));`,ctx);
 const data=()=>messages.filter(m=>m.type==='data');
 const respond=async(sent,result,error)=>{
  await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',
   type:'result',id:sent.id,result,error}});await flush();
 };
 const dispose=()=>vm.runInContext(`for(const p of pending.values()){clearTimeout(p.timer);clearTimeout(p.cancellationTimer)}`,ctx);
 return {ctx,messages,handlers,begin,data,respond,dispose};
}
function page(revision,at,last=990000,close=2){return {cache_revision:revision,as_of:at,history_boundary:false,
 bars:[last-300000,last].map(t=>({start:t,chart_time:t,end:t+300000,open:1,high:3,low:0,close,complete:true}))};}
(async()=>{
 for(const scenario of ['backfill','revision','failure','legacy','inactive']){
  const x=setup();
  try{
   x.begin('old',1,990);x.begin('newer',2,1000);
   const [older,newer]=x.data();
   assert.equal(newer.query.native_history.chart_count,1);
   await x.respond(newer,page(12,12000));await x.ctx.newer;
   await x.respond(older,page(11,11000,900000));
   const review=x.data().at(-1);
   assert.notEqual(review.id,older.id,'one bounded review follows a late snapshot');
   assert.equal(review.query.countBack,older.query.countBack);
   assert.equal(review.query.from,older.query.from);
   assert.equal(review.query.before,older.query.before);
   assert.equal(review.query.history_observation.first,600000);
   assert.equal(review.query.history_observation.last,900000,'inclusive actual last chart label');
   assert.equal(review.query.history_observation.revision,11);
   if(scenario==='inactive')vm.runInContext(`currentRes='1'`,x.ctx);
   if(scenario==='failure')await x.respond(review,null,'fixture unavailable');
   else if(scenario==='legacy')await x.respond(review,page(11,11000,900000));
   else await x.respond(review,{...page(13,13000,900000,3),history_revalidation:{changed:scenario!=='backfill'}});
   await x.ctx.old;
   assert.equal(x.ctx.delivered.length,2,'each legal native callback completes exactly once');
   assert.equal(x.ctx.failures.length,0,'review failure cannot fail an already valid original callback');
   await vm.runInContext('flushProviderCorrections()',x.ctx);await flush();
   const state=vm.runInContext(`providerHistoryState.get('MWP:BTCUSDT|5')`,x.ctx);
   assert.equal(state.cursor,990000,'older pagination cannot move latest subscription cursor');
   assert.ok(state.revision>=12,'old observations cannot overwrite an already delivered newer version');
   assert.equal(x.data().length,3,'no recursive review');
   if(scenario==='revision'){
    assert.equal(x.ctx.reloads,1);await vm.runInContext('flushProviderCorrections()',x.ctx);
    assert.equal(x.ctx.reloads,1,'confirmed revision schedules one merged reload');
   } else if(scenario==='inactive'){
    assert.equal(x.ctx.reloads,0,'inactive series keeps a correction pending');
    vm.runInContext(`currentRes='5'`,x.ctx);await vm.runInContext('flushProviderCorrections()',x.ctx);
    assert.equal(x.ctx.reloads,1,'switching back consumes the correction');
   } else assert.equal(x.ctx.reloads,0,'backfill or unproven review cannot reset historical bars');
   if(['failure','legacy'].includes(scenario)){
    assert.ok(vm.runInContext(`providerHistoryWork.get('MWP:BTCUSDT|5|').correction`,x.ctx));
    assert.ok(x.messages.some(m=>m.type==='error'));
   }
  }finally{x.dispose()}
 }
 const x=setup();
 try {
  x.begin('firstOld',1,900);x.begin('secondOld',2,910);x.begin('latest',3,1000);
  const [first,second,latest]=x.data();
  await x.respond(latest,page(12,12000));await x.ctx.latest;
  await x.respond(first,page(11,11000,900000));
  await x.respond(x.data().at(-1),{...page(13,13000,900000),history_revalidation:{changed:true}});
  await x.ctx.firstOld;
  assert.equal(x.ctx.reloads,0,'another old callback keeps correction pending');
  await x.respond(second,page(10,10000,900000));
  await x.respond(x.data().at(-1),null,'second review failed');await x.ctx.secondOld;
  await vm.runInContext('flushProviderCorrections()',x.ctx);await flush();
  assert.equal(x.ctx.reloads,1,'failed later review cannot erase a confirmed correction');
  assert.equal(x.ctx.delivered.length,3);
 } finally {x.dispose()}
 const superseded=setup();
 try {
  superseded.begin('oldResponse',1,900);superseded.begin('initialNew',2,1000);
  const [oldResponse,initialNew]=superseded.data();
  await superseded.respond(initialNew,page(12,12000));await superseded.ctx.initialNew;
  await superseded.respond(oldResponse,page(11,11000,900000));
  const initialReview=superseded.data().at(-1);
  superseded.begin('newDuringReview',3,1000);
  await superseded.respond(superseded.data().at(-1),page(13,13000));await superseded.ctx.newDuringReview;
  await superseded.respond(initialReview,{...page(12,12000,900000),history_revalidation:{changed:false}});
  await superseded.ctx.oldResponse;
  assert.equal(superseded.ctx.reloads,0);
  assert.ok(superseded.messages.some(m=>m.type==='error'),'superseded proof must be visibly unresolved');
  const refresh=vm.runInContext('refreshProviderHistoryCorrections()',superseded.ctx);
  const userReview=superseded.data().at(-1);
  assert.notEqual(userReview.id,initialReview.id,'explicit user action performs one bounded recovery');
  await superseded.respond(userReview,{...page(13,13000,900000),history_revalidation:{changed:true}});
  await refresh;
  assert.equal(superseded.ctx.reloads,1);
  assert.equal(vm.runInContext(`providerHistoryWork.get('MWP:BTCUSDT|5|').correction`,superseded.ctx),null);
 } finally {superseded.dispose()}
 const multiple=setup();
 try {
  multiple.begin('windowA',1,400);multiple.begin('windowB',2,990);multiple.begin('latestSeen',3,1000);
  const [a,b,latest]=multiple.data();
  await multiple.respond(latest,page(13,13000));await multiple.ctx.latestSeen;
  await multiple.respond(a,page(11,11000,400000));
  await multiple.respond(multiple.data().at(-1),null,'first failed');await multiple.ctx.windowA;
  await multiple.respond(b,page(12,12000,990000));
  await multiple.respond(multiple.data().at(-1),null,'second failed');await multiple.ctx.windowB;
  const correction=vm.runInContext(`providerHistoryWork.get('MWP:BTCUSDT|5|').correction`,multiple.ctx);
  assert.equal(correction.originals.length,2,'disjoint unresolved observations must both be kept');
  const recovery=vm.runInContext('refreshProviderHistoryCorrections()',multiple.ctx);
  const firstReview=multiple.data().at(-1);
  assert.equal(firstReview.query.history_observation.last,400000);
  await multiple.respond(firstReview,{...page(13,13000,400000),history_revalidation:{changed:false}});
  const secondReview=multiple.data().at(-1);
  assert.notEqual(firstReview.id,secondReview.id,'checking one window cannot consume the other');
  assert.equal(secondReview.query.history_observation.last,990000);
  await multiple.respond(secondReview,{...page(13,13000,990000),history_revalidation:{changed:true}});
  await recovery;
  assert.equal(multiple.ctx.reloads,1);
 } finally {multiple.dispose()}
 console.log('Late native history: backfill, revision, failed/legacy review and inactive correction passed');
})().catch(error=>{console.error(error);process.exitCode=1});
