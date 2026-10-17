// Playwriter session must have state.app, state.chart, state.layoutState (widget.save)
// and state.layout={phase,scenario,kind,studies:[{name,params}],count:30}.
// Cold groups reload the real app for EVERY operation; server warmth is recorded.
const fs=require('node:fs'),assert=require('assert').strict;
const evidenceModule={exports:{}};
new Function('module',fs.readFileSync('web/tests/fixtures/indicator-parity-evidence.cjs','utf8'))(evidenceModule);
const {capturePage,matchAuthority}=evidenceModule.exports;
const budgets=JSON.parse(fs.readFileSync('web/tests/fixtures/indicator-parity-budgets.json','utf8'));
const config=state.layout,budget=budgets.scenarios[config?.scenario];
assert.ok(config && budget && ['warm-layout','cold-local','cold-provider'].includes(config.scenario));
assert.ok(config.studies?.length && config.studies.length<=4 && state.layoutState);
assert.ok(config.phase && /^[a-z0-9-]+$/.test(config.phase));
assert.equal(config.saved,true,'cold recovery requires a saved real workspace');
const output='/tmp/mw-issue74-20261017/latency-'+config.phase+'.json';
assert.equal(fs.existsSync(output),false,'never overwrite a recorded group');
const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
function installProbe(){
  const wrap=adapter=>{
    if(adapter.applyBatch.__parityLayoutProbe) return adapter;
    const original=adapter.applyBatch.__parityOriginal || adapter.applyBatch;
    adapter.applyBatch=async(handle,batch)=>{
      const accepted=await original(handle,batch);
      if(accepted){
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const coverage=batch.coverage,visible=batch.rows.filter(row=>coverage && coverage.first<=row.time && row.time<=coverage.last);
        (window.parityLayoutCommits ||= []).push({at:Date.now(),epochAt:Date.now(),identity:handle.identity,coverage,
          executionEvidence:batch.executionEvidence,
          inputRevision:batch.inputRevision,displaySnapshot:batch.displaySnapshot,generation:batch.generation,
          sourceRows:visible.map(row=>({time:row.time,sourceTime:row.sourceTime})),
          finite:visible.filter(row=>row.valid.some(Boolean)).length,visibleRows:new Set(visible.map(row=>row.time)).size,
          plots:batch.rows[0]?.values.length});
      }
      return accepted;
    };
    adapter.applyBatch.__parityLayoutProbe=true;
    adapter.applyBatch.__parityOriginal=original;
    return adapter;
  };
  window.parityLayoutCommits=[];
  if(window.MWNativeIndicatorResults) wrap(window.MWNativeIndicatorResults);
  else Object.defineProperty(window,'MWNativeIndicatorResults',{configurable:true,
    get(){return this.__parityLayoutAdapter;},set(value){this.__parityLayoutAdapter=wrap(value);}});
}
// Install before navigation, so the first restored native batch cannot be missed.
await state.app.addInitScript(installProbe);
await state.chart.evaluate(installProbe);
const responses=[],pending=new Set();
const capture=response=>{
  if(!response.url().endsWith('/api/charts/data') || response.request().method()!=='POST')return;
  const query=response.request().postDataJSON();
  if(!query.indicators?.length)return;
  const task=(async()=>{
    try{
      const page=await response.json();
      responses.push(capturePage(query,page,response.status(),Date.now(),response.request().timing()));
    }catch(error){responses.push({at:Date.now(),status:response.status(),error:String(error)});}
  })();
  pending.add(task);task.finally(()=>pending.delete(task));
};
state.app.on('response',capture);
const samples=[];
try{
  for(let index=0;index<(config.count || 30);index++){
    const responseStart=responses.length;
    let at,error;
    try{
      if(config.scenario==='warm-layout'){
        at=await state.chart.evaluate(async document=>{
          window.parityLayoutCommits=[];
          const at=Date.now();await widget.load(document);return at;
        },state.layoutState);
      }else{
        at=await state.app.evaluate(()=>Date.now());
        await state.app.reload({waitUntil:'domcontentloaded',timeout:budget.timeoutMs});
        await state.app.locator('iframe[title="专业图表工作区"]').waitFor({timeout:budget.timeoutMs});
        state.chart=state.app.frames().find(frame=>frame.url().startsWith('https://127.0.0.1:17475/'));
        assert.ok(state.chart,'real app chart frame did not restore');
      }
      await state.chart.waitForFunction(({studies,at})=>{
        const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
        return studies.every(study=>(window.parityLayoutCommits || []).some(commit=>commit.at>=at && commit.finite &&
          commit.visibleRows>=commit.coverage?.count && commit.identity.algorithmVersion===study.name+':1' &&
          stable(JSON.parse(commit.identity.paramsFingerprint))===stable(study.params)));
      },{studies:config.studies,at},{timeout:Math.max(1,budget.timeoutMs-(Date.now()-at))});
      await Promise.allSettled([...pending]);
      const result=await state.chart.evaluate(({studies,at})=>{
        const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
        const commits=studies.map(study=>{
          const matching=parityLayoutCommits.filter(commit=>commit.at>=at && commit.finite &&
            commit.identity.algorithmVersion===study.name+':1' && stable(JSON.parse(commit.identity.paramsFingerprint))===stable(study.params));
          return {study,first:matching[0],covered:matching.find(commit=>commit.visibleRows>=commit.coverage?.count)};
        });
        const chart=widget.activeChart();
        const native=chart.getAllStudies().map(study=>{
          const data=chart._chartWidget.model().model().dataSourceForId(study.id).data();
          return {name:study.name,rows:data.size(),last:data.last()?.value};
        });
        return {firstMs:Math.min(...commits.map(commit=>commit.first.at))-at,
          coverageMs:Math.max(...commits.map(commit=>commit.covered.at))-at,
          symbol:chart.symbol(),commits,native};
      },{studies:config.studies,at});
      assert.equal(result.native.length,config.studies.length,'saved layout lost or duplicated a study');
      assert.ok(result.native.every(study=>study.rows>0),'restored study has no native data');
      const measured=responses.slice(responseStart);
      const provenance=config.scenario==='warm-layout' ? [...(state.layoutProvenance || []),...responses] : measured;
      const authorities=result.commits.map(commit=>matchAuthority(commit.covered,provenance,commit.study,config.kind));
      assert.ok(authorities.every(authority=>authority.complete),'missing matching execution/snapshot/revision/coverage authority');
      samples.push({index:index+1,at,...result,authorities,
        canonicalMs:Math.max(...authorities.map(authority=>authority.canonicalAt))-at,requests:measured});
    }catch(cause){error=String(cause);samples.push({index:index+1,at,firstMs:null,coverageMs:null,canonicalMs:null,error,requests:responses.slice(responseStart)});}
    console.log({sample:index+1,firstMs:samples.at(-1).firstMs,coverageMs:samples.at(-1).coverageMs,error});
  }
}finally{
  await Promise.allSettled([...pending]);state.app.off('response',capture);
}
const quantile=(key,q)=>{
  const sorted=samples.map(sample=>sample.error || sample[key]===null ? Infinity : sample[key]).sort((a,b)=>a-b);
  const value=sorted[Math.ceil(sorted.length*q)-1];return Number.isFinite(value)?value:null;
};
const metrics=Object.fromEntries(['firstMs','coverageMs','canonicalMs'].map(key=>[key,{p50:quantile(key,.5),p95:quantile(key,.95)}]));
const failures=samples.filter(sample=>sample.error).length;
const passed=samples.length>=budgets.minimumSamples && !failures && Object.values(metrics).every(metric=>Number.isFinite(metric.p95)) && metrics.firstMs.p95<budget.firstMs &&
  metrics.coverageMs.p95<budget.coverageMs && metrics.canonicalMs.p95<budget.canonicalMs;
const evidence={recordedAt:new Date().toISOString(),harnessRevision:'execution-evidence-v2',budgetRevision:budgets.revision,config,budget,
  source:'actual app / Playwriter / persisted layout / native after two RAFs',synthetic:true,
  preparation:config.scenario==='warm-layout'?'same-page widget.load':'real app reload each sample; API process stays running',
  n:samples.length,failures,quantile:'nearest-rank; failures as infinity (JSON null)',...metrics,passed,samples};
fs.writeFileSync(output,JSON.stringify(evidence,null,2),{flag:'wx'});
console.log(JSON.stringify({...evidence,samples:undefined}));
assert.equal(failures,0,'one or more layout recoveries failed; all samples retained');
if(samples.length>=budgets.minimumSamples) assert.ok(passed,'declared layout budget exceeded');
