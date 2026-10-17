const fs=require('node:fs');
function installRealReloadProbe(){
 if(location.origin!=='https://127.0.0.1:17475'||sessionStorage.getItem('mw-issue74-real-probe')!=='1')return;
 window.realCommits=[];
 const wrap=adapter=>{
  const original=adapter.applyBatch;window.realOriginalApply=original;
  adapter.applyBatch=async(handle,batch)=>{
   const accepted=await original(handle,batch);
   if(accepted){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const coverage=batch.coverage,rows=batch.rows.filter(r=>coverage&&coverage.first<=r.time&&r.time<=coverage.last);
    realCommits.push({epochAt:performance.timeOrigin+performance.now(),identity:handle.identity,coverage,
     executionEvidence:batch.executionEvidence,inputRevision:batch.inputRevision,displaySnapshot:batch.displaySnapshot,
     generation:batch.generation,sourceRows:rows.map(r=>({time:r.time,sourceTime:r.sourceTime})),finite:rows.filter(r=>r.valid.some(Boolean)).length});
   }return accepted;
  };return adapter;
 };
 Object.defineProperty(window,'MWNativeIndicatorResults',{configurable:true,
  get(){return this.__issue74RealAdapter;},set(value){this.__issue74RealAdapter=wrap(value);}});
}
await state.realChart.evaluate(()=>sessionStorage.setItem('mw-issue74-real-probe','1'));
await state.realPage.addInitScript(installRealReloadProbe);
state.realReloadStarted=Date.now();
await state.realPage.reload({waitUntil:'domcontentloaded'});
await state.realPage.locator('iframe').waitFor();
if(!state.realPage.frames().some(f=>f.url().startsWith('https://127.0.0.1:17475/')))
 await state.realPage.waitForEvent('framenavigated',{predicate:f=>f.url().startsWith('https://127.0.0.1:17475/'),timeout:15000});
state.realChart=state.realPage.frames().find(f=>f.url().startsWith('https://127.0.0.1:17475/'));
await state.realChart.waitForFunction(()=>{try{return typeof widget!=='undefined'&&widget.activeChart().getAllStudies().length===4&&realCommits.length>=4;}catch{return false;}},null,{timeout:35000});
state.realStudies=await state.realChart.evaluate(old=>widget.activeChart().getAllStudies().map(p=>({...old.find(s=>p.name.endsWith(' '+s.name)),id:p.id})),state.realStudies);
state.realEma=state.realStudies.find(p=>p.name==='EMA').id;
state.realNative=state.realPage.frames().find(f=>f.url().startsWith('blob:https://127.0.0.1:17475'));
const result=await state.realChart.evaluate(studies=>{
 const c=widget.activeChart();return {symbol:c.symbol(),resolution:c.resolution(),studies:studies.map(p=>{
  const scope=MWNativeIndicatorResults.scope(c,p.id),n=c._chartWidget.model().model().dataSourceForId(p.id);
  return {...p,scope,nativeRows:n.data().size(),nativeLast:n.data().last()?.value,
   commit:realCommits.filter(x=>x.identity.algorithmVersion===p.name+':1'&&x.generation===scope.coverage?.generation).at(-1)};
 })};
},state.realStudies);
await Promise.race([Promise.allSettled([...state.realReviewPending]),new Promise(resolve=>setTimeout(resolve,1500))]);
for(const p of result.studies)p.authority=state.realEvidence.matchAuthority(p.commit,state.realExecutions.filter(r=>r.at>=state.realReloadStarted),p,'provider');
fs.writeFileSync(state.realReviewDir+'/13-reloaded-real-layout.json',JSON.stringify({started:state.realReloadStarted,elapsed:Date.now()-state.realReloadStarted,result,
 executions:state.realExecutions.filter(r=>r.at>=state.realReloadStarted),errors:state.realReviewErrors},null,2));
await state.realPage.screenshot({path:state.realReviewDir+'/13-xau500-after-reload.png',scale:'css'});
console.log({elapsed:Date.now()-state.realReloadStarted,symbol:result.symbol,period:result.resolution,studies:result.studies.map(p=>({name:p.name,params:p.params,rows:p.nativeRows,finite:p.commit?.finite,last:p.nativeLast,origin:p.commit?.identity.calculationStart,authority:p.authority.complete}))});
