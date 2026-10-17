// Actual app HTTP, parent labels and pinned native display under delayed edits.
const assert=require('assert').strict,fs=require('node:fs');
console.log(await snapshot({page:state.app}));
await state.chart.evaluate(()=>new Promise(resolve=>widget.activeChart().setSymbol('PARITY',resolve)));
await state.chart.evaluate(()=>widget.activeChart().getAllStudies().forEach(study=>widget.activeChart().removeEntity(study.id)));
state.appStudy=await state.chart.evaluate(()=>widget.activeChart().createStudy('守望 Python LWMA',false,false,{period:5}));
await state.chart.waitForFunction(id=>MWNativeIndicatorResults.scope(widget.activeChart(),id)?.coverage,state.appStudy,{timeout:10000});
const sample=()=>state.chart.evaluate(id=>{
  const chart=widget.activeChart(),native=chart._chartWidget.model().model().dataSourceForId(id);
  return {rows:native.data().size(),last:native.data().last()?.value,scope:MWNativeIndicatorResults.scope(chart,id)};
},state.appStudy);
const before=await sample();
state.appHeld=0;
state.appGate=new Promise(resolve=>state.appRelease=resolve);
state.appRoute=async route=>{
  const q=route.request().postDataJSON();
  if(q?.indicators?.some(spec=>spec.name==='LWMA' && spec.params.period===13)){
    state.appHeld++;await state.appGate;
  }
  await route.continue().catch(()=>{});
};
await state.app.route('**/api/charts/data',state.appRoute);
try {
  await state.chart.evaluate(id=>widget.activeChart().getStudyById(id).setInputValues([{id:'period',value:13}]),state.appStudy);
  await state.app.getByRole('complementary',{name:'图格指标状态'}).getByText(/暂显旧参数：period=5/).waitFor({timeout:5000});
  const delayed=await sample();
  assert.equal(delayed.rows,before.rows);assert.deepEqual(delayed.last,before.last);
  assert.equal(delayed.scope.transition.params.period,5);
  await state.app.screenshot({path:'/tmp/mw-issue74-20261017/app-delayed-parameter.png',scale:'css'});
  console.log(await snapshot({page:state.app}));
  state.appRelease();
  await state.chart.waitForFunction(id=>{
    const scope=MWNativeIndicatorResults.scope(widget.activeChart(),id);
    return scope?.coverage && !scope.transition && JSON.parse(JSON.parse(scope.coverage.identity).paramsFingerprint).period===13;
  },state.appStudy,{timeout:10000});
  const after=await sample();assert.notDeepEqual(after.last,before.last);
  const evidence={source:'actual app / Playwriter / real delayed HTTP',synthetic:true,before,delayed,after,heldRequests:state.appHeld,
    label:'暂显旧参数：period=5',passed:true};
  fs.writeFileSync('/tmp/mw-issue74-20261017/app-transition.json',JSON.stringify(evidence,null,2));
  console.log(evidence);console.log(await getLatestLogs({page:state.app,sinceLastCall:true,count:6}));
}finally{state.appRelease();await state.app.unroute('**/api/charts/data',state.appRoute);}
