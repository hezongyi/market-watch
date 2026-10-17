const fs=require('node:fs');
const plans=[{name:'EMA',id:state.realEma,params:{period:20}},
 {name:'BBANDS',params:{period:20,deviation:2}},
 {name:'MACD',params:{fast:12,slow:26,signal:9}},
 {name:'SUPERTREND_PINE_V1',params:{period:10,source:'hl2',multiplier:3,atr_method:'wilder'},inputs:{period:10,source:'hl2',multiplier:3,changeATR:true,showsignals:true,highlighting:true}}];
state.realStudies=[];
for(const plan of plans){
 const started=Date.now();let id=plan.id,result,error;
 try{
  if(!id)id=await state.realChart.evaluate(p=>widget.activeChart().createStudy('守望 Python '+p.name,false,false,p.inputs||p.params),plan);
  await state.realChart.waitForFunction(({id,name,params})=>{
   const c=widget.activeChart(),s=MWNativeIndicatorResults.scope(c,id),stable=x=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))));
   return s?.coverage&&!s.transition&&realCommits.some(c=>c.identity.algorithmVersion===name+':1'&&c.identity.paramsFingerprint===stable(params));
  },{id,name:plan.name,params:plan.params},{timeout:20000});
  await Promise.race([Promise.allSettled([...state.realReviewPending]),new Promise(resolve=>setTimeout(resolve,2000))]);
  result=await state.realChart.evaluate(({id,name,params})=>{
   const c=widget.activeChart(),native=c._chartWidget.model().model().dataSourceForId(id),stable=x=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))));
   return {symbol:c.symbol(),resolution:c.resolution(),scope:MWNativeIndicatorResults.scope(c,id),nativeRows:native.data().size(),nativeLast:native.data().last()?.value,
    commit:realCommits.filter(x=>x.identity.algorithmVersion===name+':1'&&x.identity.paramsFingerprint===stable(params)).at(-1)};
  },{id,name:plan.name,params:plan.params});
  result.authority=state.realEvidence.matchAuthority(result.commit,state.realExecutions,plan,'provider');
 }catch(e){error=String(e);}
 const record={operation:'add',name:plan.name,params:plan.params,id,started,observedAt:Date.now(),result,error};
 state.realStudies.push({...plan,id});state.realOperations.push(record);
 fs.writeFileSync(state.realReviewDir+'/four-studies.json',JSON.stringify({source:'real Dukascopy EUR/USD H4, actual native studies; exploratory checks, not p95',operations:state.realOperations,executions:state.realExecutions},null,2));
 console.log({name:plan.name,elapsed:Date.now()-started,error,rows:result?.nativeRows,authority:result?.authority.complete,authorityReason:result?.authority.reason});
}
await state.realPage.screenshot({path:state.realReviewDir+'/03-four-real-studies.png',scale:'css'});
console.log(await snapshot({page:state.realPage}));
