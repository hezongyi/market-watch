// Runtime regression: shared transport failures and stale async completions.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(count=8){
 let clock=0,next=0,symbol='MWP:A';const tasks=new Map(),models=[],listeners=[],deferred=[],requests=[];
 const ctx=vm.createContext({URLSearchParams,location:{search:''},performance:{now:()=>clock},
  setTimeout:(fn,delay)=>{const id=++next;tasks.set(id,{fn,at:clock+delay});return id;},
  clearTimeout:id=>tasks.delete(id),cancelAnimationFrame:id=>tasks.delete(id),
  requestAnimationFrame:fn=>{const id=++next;tasks.set(id,{fn,at:clock+16});return id;}});
 vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../advanced-host/native-reserve.js'),'utf8'),ctx);
 const api=ctx.MWNativeReserve;
 function thread(ticker){const t={_symbolInfo:{ticker},_resolution:'5',_cache:{bars:[{time:100000}]},_dealignTime:t=>t,
  _processBars(){t.processed=(t.processed||0)+1;},_setEndOfData(){t._endOfData=true;}};
  api.bindThread(t,t._symbolInfo,'5');return t;}
 const a=thread('MWP:A'),b=thread('MWP:B');
 function addModel(initialOffset=0){
  const event={subscribe:(_,fn)=>listeners.push(fn),unsubscribeAll(){}};
  let offset=initialOffset;const ts={visibleBarsStrictRange:()=>({firstBar:()=>0}),points:()=>({range:()=>({value:()=>({firstIndex:0})}),valueAt:()=>100}),width:()=>600,barSpacing:()=>6,rightOffset:()=>offset,visibleBarsStrictRangeChanged:()=>event,barSpacingChanged:()=>event};
  const m={timeScale:()=>ts,mainSeries:()=>({symbol:()=>symbol,_colorOnPrevBar:()=>false}),interval:()=> '5'};
  const entry={m,move:delta=>{offset+=delta;listeners.forEach(fn=>fn());}};models.push(entry);api.bindModel(m);return entry;
 }
 for(let i=0;i<count;i++)addModel(i*20);
 api.configure(args=>{requests.push({...args,at:clock});return new Promise((resolve,reject)=>deferred.push({resolve,reject,args}));});
 async function flush(){for(let n=0;n<20;n++)await Promise.resolve();}
 async function advance(ms){const end=clock+ms;for(let steps=0;steps<1000;steps++){
  await flush();const due=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
  if(!due){clock=end;await flush();return;}tasks.delete(due[0]);clock=due[1].at;due[1].fn();
 }throw Error('scheduler loop');}
 return{api,a,b,models,requests,deferred,advance,flush,addModel,switch:(next='MWP:B')=>{symbol=next;listeners.forEach(fn=>fn());}};
}
(async()=>{
 for(const fault of ['error','miss','alternating']){
  const f=fixture();await f.advance(100);assert.equal(f.requests.length,1);
  for(let attempt=0;attempt<4;attempt++){
   const d=f.deferred[attempt];assert.ok(d);
   const error=fault==='error'||fault==='alternating'&&attempt%2===0;
   if(error)d.reject(Error('HTTP failure'));else d.resolve({bars:[],history_boundary:false});
   await f.flush();const wait=error?1000*2**(f.api.diagnostics().models[0].state.failures-1):1500;
   await f.advance(wait-100);assert.equal(f.requests.length,attempt+1,'all peers must share backoff');
   await f.advance(200);
   assert.equal(f.requests.length,Math.min(attempt+2,4),'one shared request per retry');
  }
  await f.advance(60000);assert.equal(f.requests.length,4,'stop after four attempts across all panes');
  f.models[7].move(-20);await f.advance(100);assert.equal(f.requests.length,4,'sub-quarter-screen move cannot restart');
  f.models[7].move(-10);await f.advance(100);assert.equal(f.requests.length,5,'real quarter-screen move restarts shared demand');
  const states=f.api.diagnostics().models.map(m=>m.state);assert.ok(states.every(s=>s.failures===0&&s.misses===0));
 }
 for(const change of ['new-pane','switch-back']){
  const f=fixture(1);await f.advance(100);
  for(let attempt=0;attempt<4;attempt++){f.deferred[attempt].reject(Error('exhaust'));await f.flush();await f.advance(1000*2**attempt+100);}
  assert.equal(f.requests.length,4);
  let pane=f.models[0];
  if(change==='new-pane'){pane=f.addModel(500);await f.advance(100);}
  else{f.switch();await f.advance(100);f.switch('MWP:A');await f.advance(100);}
  assert.equal(f.requests.filter(r=>r.symbol==='MWP:A').length,4,'joining exhausted demand must not automatically retry');
  pane.move(-20);await f.advance(100);assert.equal(f.requests.filter(r=>r.symbol==='MWP:A').length,4);
  pane.move(-10);await f.advance(100);assert.equal(f.requests.filter(r=>r.symbol==='MWP:A').length,5,'new/rejoined pane movement must restart demand');
 }
 for(const outcome of ['error','success']){
  const f=fixture(1);await f.advance(100);f.switch();await f.advance(100);assert.deepEqual(f.requests.map(r=>r.symbol),['MWP:A','MWP:B']);
  await f.advance(1000);
  if(outcome==='error')f.deferred[0].reject(Error('old request'));else f.deferred[0].resolve({bars:[{time:90000}],history_boundary:false});
  await f.flush();const state=f.api.diagnostics().models[0].state;
  assert.equal(state.failures,0,'old request must not spend the new symbol retry budget');assert.equal(state.retryAt,0);assert.equal(state.enhancedUntil,0,'old latency must not change the new symbol tier');
 }
 for(const outcome of ['error','success']){
  const f=fixture(1);await f.advance(100);f.api.unbindThread(f.a);f.a._destroyed=true;
  if(outcome==='error')f.deferred[0].reject(Error('destroyed thread'));else f.deferred[0].resolve({bars:[{time:90000}],history_boundary:false});
  await f.flush();await f.advance(10000);assert.equal(f.a.processed,undefined);assert.equal(f.requests.length,1);
 }
 for(const outcome of ['boundary','miss','error','bars'])for(const first of [100000,1000000]){
  const f=fixture(1);await f.advance(100);await f.advance(1000);
  // Native _purgeCache replaces the cache but keeps the same thread, including
  // when a later mandatory load happens to return exactly the same first bar.
  f.a._cache={bars:[{time:first}]};f.a._endOfData=false;
  if(outcome==='error')f.deferred[0].reject(Error('before reset'));
  else f.deferred[0].resolve({bars:outcome==='bars'?[{time:90000}]:[],history_boundary:outcome==='boundary'});
  await f.flush();await f.advance(100);
  const state=f.api.diagnostics().models[0].state;
  assert.equal(!!f.a._endOfData,false,'old boundary cannot end reset cache');
  assert.equal(f.a.processed,undefined,'old rows cannot enter reset cache');
  assert.equal(state.failures+state.misses,0,'old outcome cannot spend reset retry budget');
  assert.equal(state.enhancedUntil,0,'old latency cannot enhance reset cache');
  assert.equal(f.requests.length,2,'reset demand resumes after obsolete completion');
 }
 for(const outcome of ['boundary','error']){
  const f=fixture(1);await f.advance(100);
  f.a._cache.bars=[{time:1000000}];
  if(outcome==='error')f.deferred[0].reject(Error('obsolete cursor'));
  else f.deferred[0].resolve({bars:[],history_boundary:true});
  await f.flush();await f.advance(100);
  assert.equal(!!f.a._endOfData,false,'mandatory paging invalidates old reserve cursor');
  assert.equal(f.api.diagnostics().models[0].state.failures,0);
  assert.equal(f.requests.length,2);
 }
 {
  const f=fixture(1);await f.advance(100);
  f.deferred[0].resolve({bars:[],history_boundary:true});await f.flush();
  assert.equal(f.a._endOfData,true,'current confirmed boundary still stops');
  f.a._cache={bars:[{time:100000}]};f.a._endOfData=false;
  f.api.delivered(f.a._symbolInfo,'5',1);await f.advance(100);
  assert.equal(f.requests.length,2,'reset clears latched reserve boundary');
 }
 console.log('Shared error/miss backoff, bounded retries, viewport restart and stale completion isolation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
