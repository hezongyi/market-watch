const fs=require('node:fs');
const plan=state.realScenario,started=Date.now();
let error,result;
try{
 await state.realChart.evaluate(p=>{
  const c=widget.activeChart();
  if(p.period!==undefined)c.getStudyById(p.emaId).setInputValues([{id:'period',value:p.period}]);
  if(p.resolution)c.setResolution(p.resolution,()=>{});
  if(p.symbol)c.setSymbol(p.symbol,()=>{});
 },{...plan,emaId:state.realEma});
 if(plan.period!==undefined)state.realStudies.find(p=>p.name==='EMA').params={period:plan.period};
 await state.realChart.waitForFunction(({studies,started,symbol,resolution})=>{
  const c=widget.activeChart();
  if(symbol&&c.symbol().toLowerCase()!==symbol.toLowerCase()||resolution&&c.resolution()!==resolution)return false;
  const stable=x=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))));
  return studies.every(p=>{
   const s=MWNativeIndicatorResults.scope(c,p.id);if(!s?.coverage||s.transition)return false;
   const identity=JSON.parse(s.coverage.identity);
   if(identity.main.toLowerCase()!==c.symbol().toLowerCase()||identity.period!==c.resolution()||identity.paramsFingerprint!==stable(p.params))return false;
   return realCommits.some(x=>x.identity.algorithmVersion===p.name+':1'&&x.identity.paramsFingerprint===stable(p.params)&&
    x.identity.main.toLowerCase()===c.symbol().toLowerCase()&&x.identity.period===c.resolution()&&
    x.generation===s.coverage.generation&&(p.name!=='EMA'||x.epochAt>=started));
  });
 },{studies:state.realStudies,started,symbol:plan.symbol,resolution:plan.resolution},{timeout:40000});
 await Promise.race([Promise.allSettled([...state.realReviewPending]),new Promise(resolve=>setTimeout(resolve,1500))]);
 result=await state.realChart.evaluate(studies=>{
  const c=widget.activeChart(),stable=x=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))));
  return {symbol:c.symbol(),resolution:c.resolution(),studies:studies.map(p=>{
   const scope=MWNativeIndicatorResults.scope(c,p.id),n=c._chartWidget.model().model().dataSourceForId(p.id);
   return {...p,scope,nativeRows:n.data().size(),nativeLast:n.data().last()?.value,
    commit:realCommits.filter(x=>x.identity.algorithmVersion===p.name+':1'&&x.identity.paramsFingerprint===stable(p.params)&&
     x.identity.main.toLowerCase()===c.symbol().toLowerCase()&&x.identity.period===c.resolution()&&x.generation===scope.coverage.generation).at(-1)};
  })};
 },state.realStudies);
 for(const p of result.studies)p.authority=state.realEvidence.matchAuthority(p.commit,state.realExecutions,p,'provider');
}catch(e){error=String(e);result=await state.realChart.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),studies:widget.activeChart().getAllStudies().map(p=>({...p,scope:MWNativeIndicatorResults.scope(widget.activeChart(),p.id)}))}));}
const record={plan,started,observedAt:Date.now(),elapsed:Date.now()-started,error,result,
 responses:state.realReviewResponses.filter(r=>r.at>=started),executions:state.realExecutions,errors:state.realReviewErrors};
fs.writeFileSync(state.realReviewDir+'/'+plan.label+'.json',JSON.stringify(record,null,2));
console.log({label:plan.label,elapsed:record.elapsed,error,symbol:result?.symbol,resolution:result?.resolution,
 studies:result?.studies.map(s=>({name:s.name,params:s.params,rows:s.nativeRows,authority:s.authority?.complete,reason:s.authority?.reason,transition:s.scope?.transition})),
 httpErrors:record.responses.filter(r=>r.status>=400).map(r=>({path:r.path,status:r.status,detail:r.detail}))});
