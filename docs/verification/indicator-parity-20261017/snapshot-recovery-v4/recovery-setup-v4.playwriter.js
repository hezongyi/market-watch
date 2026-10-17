const assert=require('assert').strict;
await state.app.reload({waitUntil:'domcontentloaded'});
await state.app.locator('iframe[title="专业图表工作区"]').waitFor();
let frame=state.app.frames().find(f=>f.url().startsWith('https://127.0.0.1:17475/'));
if(!frame){await state.app.waitForEvent('framenavigated',{predicate:f=>f.url().startsWith('https://127.0.0.1:17475/'),timeout:10000});frame=state.app.frames().find(f=>f.url().startsWith('https://127.0.0.1:17475/'));}
state.chart=frame;
await state.chart.waitForFunction(()=>{try{return typeof widget!=='undefined'&&widget.activeChart()&&widget.activeChart().getVisibleRange();}catch{return false;}});
assert.equal(await state.chart.evaluate(()=>recoverDisplaySnapshot.toString().includes('boundToken')),true);
await state.chart.evaluate(()=>widget.activeChart().getAllStudies().forEach(s=>widget.activeChart().removeEntity(s.id)));
const symbol='MWC:2bcbc81d8e0e33b2318774f24638e2327448c8d3ecae8d190915cb94b50f637b';
await state.chart.evaluate(symbol=>new Promise(resolve=>{const c=widget.activeChart();if(c.symbol().toUpperCase()===symbol.toUpperCase())resolve();else c.setSymbol(symbol,resolve);}),symbol);
await state.chart.evaluate(()=>new Promise(resolve=>{const c=widget.activeChart();if(c.resolution()==='1')resolve();else c.setResolution('1',resolve);}));
await state.chart.evaluate(()=>new Promise(resolve=>{if(widget.activeChart().dataReady(resolve))resolve();}));
await state.chart.waitForFunction(()=>!!indicatorBindings.get(indicatorKey(widget.activeChart().symbol(),'1'))?.displaySnapshot);
state.recoveryResults=[];
state.recoveryResponses=[];
state.recoveryPending=new Set();
const evidenceModule={exports:{}};
new Function('module',require('node:fs').readFileSync('web/tests/fixtures/indicator-parity-evidence.cjs','utf8'))(evidenceModule);
state.recoveryEvidence=evidenceModule.exports;
state.recoveryCapture=response=>{
  if(!response.url().endsWith('/api/charts/data')||response.request().method()!=='POST')return;
  const q=response.request().postDataJSON();
  const task=(async()=>{try{
    const page=await response.json();
    const record=state.recoveryEvidence.capturePage(q,page,response.status(),Date.now(),response.request().timing());
    if(response.status()!==200)record.detail=page.detail;
    state.recoveryResponses.push(record);
  }catch(error){state.recoveryResponses.push({status:response.status(),error:String(error)});}})();
  state.recoveryPending.add(task);task.finally(()=>state.recoveryPending.delete(task));
};
state.app.on('response',state.recoveryCapture);
await state.chart.evaluate(()=>{
  window.recoveryCommits=[];
  window.recoveryOriginalApply=MWNativeIndicatorResults.applyBatch;
  MWNativeIndicatorResults.applyBatch=async(handle,batch)=>{
    const accepted=await recoveryOriginalApply(handle,batch);
    if(accepted){
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const coverage=batch.coverage,rows=batch.rows.filter(r=>coverage&&coverage.first<=r.time&&r.time<=coverage.last);
      recoveryCommits.push({epochAt:performance.timeOrigin+performance.now(),identity:handle.identity,coverage,
        executionEvidence:batch.executionEvidence,inputRevision:batch.inputRevision,displaySnapshot:batch.displaySnapshot,
        sourceRows:rows.map(r=>({time:r.time,sourceTime:r.sourceTime})),finite:rows.filter(r=>r.valid.some(Boolean)).length});
    }
    return accepted;
  };
});
console.log({candidateGuard:true,symbol:await state.chart.evaluate(()=>widget.activeChart().symbol()),source:'actual task app, Playwriter, intercepted HTTP and native rendering'});
