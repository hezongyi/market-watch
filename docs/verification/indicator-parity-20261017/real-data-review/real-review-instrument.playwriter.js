const fs=require('node:fs');const m={exports:{}};
new Function('module',fs.readFileSync('web/tests/fixtures/indicator-parity-evidence.cjs','utf8'))(m);state.realEvidence=m.exports;
state.realExecutions=[];state.realJobQueries=new Map();
state.realExecutionCapture=response=>{
 const path=new URL(response.url()).pathname;
 if(!path.startsWith('/api/charts/')||response.request().method()!=='POST'&&!path.includes('/result'))return;
 const job=(async()=>{try{
  const raw=response.request().method()==='POST'?response.request().postDataJSON():null;
  const d=await response.json();let q=raw?.query||raw;
  if(d.load?.id&&q)state.realJobQueries.set(d.load.id,q);
  if(!q)q=state.realJobQueries.get(path.split('/')[4]);
  const page=d.result||d;
  if(q&&page.indicators?.length)state.realExecutions.push(state.realEvidence.capturePage(q,page,response.status(),Date.now(),response.request().timing()));
 }catch{}})();state.realReviewPending.add(job);job.finally(()=>state.realReviewPending.delete(job));
};state.realPage.on('response',state.realExecutionCapture);
await state.realChart.evaluate(()=>{
 window.realCommits=[];window.realOriginalApply=MWNativeIndicatorResults.applyBatch;
 MWNativeIndicatorResults.applyBatch=async(handle,batch)=>{
  const accepted=await realOriginalApply(handle,batch);
  if(accepted){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const coverage=batch.coverage,rows=batch.rows.filter(r=>coverage&&coverage.first<=r.time&&r.time<=coverage.last);
   realCommits.push({epochAt:performance.timeOrigin+performance.now(),identity:handle.identity,coverage,
    executionEvidence:batch.executionEvidence,inputRevision:batch.inputRevision,displaySnapshot:batch.displaySnapshot,generation:batch.generation,
    sourceRows:rows.map(r=>({time:r.time,sourceTime:r.sourceTime})),finite:rows.filter(r=>r.valid.some(Boolean)).length});
  }return accepted;
 };
});
state.realOperations=[];
await state.realNative.getByRole('option',{name:'添加到收藏 Python EMA',exact:true}).click();
await state.realNative.locator('body').press('Escape');
await state.realChart.waitForFunction(()=>widget.activeChart().getAllStudies().length>0);
state.realEma=await state.realChart.evaluate(()=>widget.activeChart().getAllStudies().find(s=>s.name.includes('EMA')).id);
console.log({addedByUI:true,id:state.realEma,studies:await state.realChart.evaluate(()=>widget.activeChart().getAllStudies())});
