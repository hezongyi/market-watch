// Prepare through the actual study and workspace save flows before declaring
// a warm/cold layout group. This preparation is outside the timed operations.
const fs=require('node:fs'),assert=require('assert').strict;
const evidenceModule={exports:{}};
new Function('module',fs.readFileSync('web/tests/fixtures/indicator-parity-evidence.cjs','utf8'))(evidenceModule);
const {capturePage}=evidenceModule.exports;
assert.ok(state.layout?.studies?.length && state.layout.studies.length<=4);
const responses=[],pending=new Set();
const capture=response=>{
  if(!response.url().endsWith('/api/charts/data') || response.request().method()!=='POST')return;
  const query=response.request().postDataJSON();
  if(!query.indicators?.length)return;
  const task=(async()=>{
    try{responses.push(capturePage(query,await response.json(),response.status(),Date.now(),response.request().timing()));}
    catch(error){responses.push({at:Date.now(),status:response.status(),error:String(error)});}
  })();
  pending.add(task);task.finally(()=>pending.delete(task));
};
state.app.on('response',capture);
try{
  await state.chart.evaluate(()=>widget.activeChart().getAllStudies().forEach(study=>widget.activeChart().removeEntity(study.id)));
  for(const study of state.layout.studies){
    const id=await state.chart.evaluate(async study=>widget.activeChart().createStudy('守望 Python '+study.name,
      false,false,study.inputs || study.params),study);
    await state.chart.waitForFunction(id=>MWNativeIndicatorResults.scope(widget.activeChart(),id)?.coverage,
      id,{timeout:30000});
  }
  await Promise.allSettled([...pending]);
  state.layoutState=await state.chart.evaluate(()=>new Promise(resolve=>widget.save(resolve)));
  state.layoutProvenance=responses;
  const saved=state.app.waitForResponse(response=>response.request().method()==='POST' &&
    response.url().includes('/api/advanced-charts/') && response.url().endsWith('/save'),{timeout:20000});
  await state.app.evaluate(()=>dispatchEvent(new KeyboardEvent('keydown',
    {key:'s',ctrlKey:true,bubbles:true,cancelable:true})));
  const response=await saved;
  assert.equal(response.status(),200,'real workspace save failed');
  state.layout.saved=true;
  console.log({saved:true,studies:state.layout.studies.map(study=>study.name),
    symbol:await state.chart.evaluate(()=>widget.activeChart().symbol()),canonicalResponses:responses.length});
}finally{
  await Promise.allSettled([...pending]);state.app.off('response',capture);
}
