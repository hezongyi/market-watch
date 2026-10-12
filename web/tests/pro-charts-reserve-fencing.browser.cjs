// Capture the shipped configure boundary before boot, retaining the actual
// transport. These controlled snapshot changes test real API response fencing.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product({initScript:()=>{
 let value;Object.defineProperty(globalThis,'MWNativeReserve',{configurable:true,get:()=>value,set:v=>{value=v;const configure=v.configure;v.configure=function(read,...args){globalThis.acceptanceReserveRead=read;return configure.call(this,read,...args);};}});
}}),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 try {
  await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('s');widget.activeChart().removeAllStudies();widget.activeChart().setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');});
  await p.host.waitForFunction(()=>widget.activeChart().dataReady()&&!loading&&!pending.size&&!requests.length&&!MWNativeNavigation.busy(),null,{timeout:60000});
  await p.host.evaluate(()=>widget.activeChart().setResolution('60',{doNotActivateChart:true}));await p.host.waitForFunction(()=>widget.activeChart().dataReady()&&widget.activeChart().resolution()==='60'&&!pending.size&&!requests.length);
  for(const change of ['unchanged','input_revision','binding','cancelled_consumer']) {
   let release,observed;const gate=new Promise(ok=>release=ok),seen=new Promise(ok=>observed=ok);let armed=true;
   await p.page.route('**/api/charts/data',async route=>{try{const q=route.request().postDataJSON();if(armed&&q.series_kind==='composite'&&q.limit===17){armed=false;observed(q);const response=await route.fetch();await gate;return await route.fulfill({response});}return await route.continue();}catch{return;}});
   const initial=await p.host.evaluate(()=>{const c=widget.activeChart(),identity=MWSeries.decode(c.symbol()),key=MWSeries.encode(identity.symbol,identity.series_kind)+'|'+c.resolution()+'|';globalThis.acceptanceFenceCurrent=true;globalThis.acceptanceFenceState=structuredClone(marketHistoryState.get(key));const before=c.getVisibleRange().from*1000;
    globalThis.acceptanceFenceResult=null;acceptanceReserveRead({symbol:c.symbol(),resolution:c.resolution(),before,screen_bars:17,batch_screens:1,current:()=>acceptanceFenceCurrent}).then(page=>acceptanceFenceResult={rows:page.bars.length,revision:page.revision_id,input:page.input_revision},e=>acceptanceFenceResult={code:e.code,error:String(e)});return{key,state:acceptanceFenceState};});
   const query=await Promise.race([seen,new Promise((_,reject)=>setTimeout(()=>reject(Error('No actual reserve HTTP request')),30000))]);assert.equal(query.composite_revision_id,initial.state.binding);assert.equal(query.input_revision,initial.state.input_revision);
   await p.host.evaluate(({change,key})=>{const state=marketHistoryState.get(key);if(change==='input_revision')state.input_revision++;else if(change==='binding')state.binding='controlled-replacement-revision';else if(change==='cancelled_consumer')acceptanceFenceCurrent=false;},{change,key:initial.key});release();
   await p.host.waitForFunction(()=>acceptanceFenceResult!==null);const result=await p.host.evaluate(()=>acceptanceFenceResult);
   if(change==='unchanged')assert.ok(result.rows>0);else assert.equal(result.code,'HISTORY_CANCELLED');
   await p.host.evaluate(key=>marketHistoryState.set(key,acceptanceFenceState),initial.key);await p.page.unrouteAll({behavior:'wait'});r.cases.push({name:'actual fixed reserve transport with controlled snapshot transition',change,query:{revision:query.composite_revision_id,input:query.input_revision},result});
  }
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-reserve-fencing.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
