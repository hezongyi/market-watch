// Run at repo root with Playwriter -s SESSION -f FILE and an authenticated app.
// state.latency declares the group BEFORE sampling. See plan §3; no reclassification.
const fs = require('node:fs');
const assert = require('assert').strict;
const budgets = JSON.parse(fs.readFileSync('web/tests/fixtures/indicator-parity-budgets.json','utf8'));
const evidenceModule={exports:{}};
new Function('module',fs.readFileSync('web/tests/fixtures/indicator-parity-evidence.cjs','utf8'))(evidenceModule);
const {capturePage,matchAuthority,validatePreparation}=evidenceModule.exports;
const config = state.latency;
assert.ok(config, 'declare state.latency before measuring');
const budget = budgets.scenarios[config.scenario];
assert.ok(budget, 'unknown budget scenario');
assert.ok(['add','edit'].includes(config.operation), 'this harness measures loaded add/edit only; use a layout harness for page setup');
assert.ok(config.scenario.startsWith('loaded-') || config.scenario.startsWith('long-'));
assert.ok(config.phase && /^[a-z0-9-]+$/.test(config.phase));
assert.ok(config.kind && config.indicator && config.specs?.length);
assert.ok(config.prefixRows > 0 && config.prefixRows <= (config.scenario.startsWith('long-') ? 50000 : 6000));
if(config.scenario.startsWith('long-')) assert.ok(config.prefixRows > 6000);
const complex = ['SWING_SR_V1','SUPERTREND_PINE_V1'].includes(config.indicator);
if(config.scenario !== 'loaded-reusable') {
  assert.equal(config.scenario.includes('complex'),complex,'declare complex catalog separately');
  assert.equal(config.knownUnused,true,'new-spec group requires previously unused specifications');
} else assert.equal(config.prewarm,true,'prepare reusable result before each measured operation');
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b))));
assert.equal(new Set(config.specs.map(spec=>canonical(spec.params))).size,config.specs.length,'specs must be distinct within the group');
const output = '/tmp/mw-issue74-20261017/latency-'+config.phase+'.json';
assert.equal(fs.existsSync(output),false,'never overwrite a recorded group');
assert.ok(state.chart && state.app, 'open the isolated app first');
const environment = await state.chart.evaluate(() => ({symbol:widget.activeChart().symbol(),range:widget.activeChart().getVisibleRange(),timeOrigin:performance.timeOrigin}));
assert.equal(environment.symbol.toUpperCase(),config.symbol?.toUpperCase(),'declare the exact series before sampling');
const responses = [], pending = new Set();
const capture = response => {
  if(!response.url().endsWith('/api/charts/data') || response.request().method() !== 'POST') return;
  const query=response.request().postDataJSON();
  if(!query.indicators?.some(item=>item.name===config.indicator)) return;
  const task=(async()=>{
    try {
      const page=await response.json();
      responses.push(capturePage(query,page,response.status(),Date.now(),response.request().timing()));
    }catch(error){responses.push({at:Date.now(),status:response.status(),error:String(error)});}
  })();
  pending.add(task);task.finally(()=>pending.delete(task));
};
state.app.on('response',capture);
const samples=[];
try {
  await state.chart.evaluate(() => {
    widget.activeChart().getAllStudies().forEach(study=>widget.activeChart().removeEntity(study.id));
    // Replace any previous diagnostic wrapper instead of nesting observers.
    const original=window.parityOriginalApply || MWNativeIndicatorResults.applyBatch.__parityOriginal || MWNativeIndicatorResults.applyBatch;
    window.parityOriginalApply=original;
    window.parityCommits=[];
    MWNativeIndicatorResults.applyBatch=async(handle,batch)=>{
      const accepted=await original(handle,batch);
      if(accepted){
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const coverage=batch.coverage;
        const visible=batch.rows.filter(row=>coverage && coverage.first<=row.time && row.time<=coverage.last);
        const at=performance.now();
        parityCommits.push({at,epochAt:performance.timeOrigin+at,identity:handle.identity,coverage,
          executionEvidence:batch.executionEvidence,
          inputRevision:batch.inputRevision,displaySnapshot:batch.displaySnapshot,generation:batch.generation,
          sourceRows:visible.map(row=>({time:row.time,sourceTime:row.sourceTime})),
          finite:visible.filter(row=>row.valid.some(Boolean)).length,
          visibleRows:new Set(visible.map(row=>row.time)).size,
          plots:batch.rows[0]?.values.length,kind:batch.kind});
      }
      return accepted;
    };
  });
  for(const [index,spec] of config.specs.entries()) {
    const inputs=spec.inputs || spec.params;
    let id,operation,error;
    const warmupStart=responses.length;
    const create=()=>state.chart.evaluate(async({name,inputs})=>{
      const at=performance.now();
      const id=await widget.activeChart().createStudy('守望 Python '+name,false,false,inputs);
      return {id,at};
    },{name:config.indicator,inputs});
    const wait=()=>state.chart.waitForFunction(({params,name,at})=>{
      const fingerprint=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
      return parityCommits.some(commit=>commit.at>=at && commit.coverage &&
        commit.visibleRows>=commit.coverage.count && commit.identity.algorithmVersion===name+':1' &&
        fingerprint(JSON.parse(commit.identity.paramsFingerprint))===fingerprint(params));
    },{params:spec.params,name:config.indicator,at:operation.at},{timeout:budget.timeoutMs});
    try {
      if(config.prewarm && config.operation==='edit') {
        operation=await create();id=operation.id;
        await wait();
        await Promise.allSettled([...pending]);
        await state.chart.evaluate(id=>widget.activeChart().removeEntity(id),id);id=undefined;
      }
      if(config.prewarm || config.operation==='edit') {
        const initial=config.operation==='edit' ? config.initial : spec;
        assert.ok(initial?.params, 'edit needs an initial current-spec curve');
        operation=await state.chart.evaluate(async({name,initial})=>{
          const at=performance.now();
          return {at,id:await widget.activeChart().createStudy('守望 Python '+name,false,false,initial.inputs || initial.params)};
        },{name:config.indicator,initial});
        id=operation.id;
        await state.chart.waitForFunction(id=>MWNativeIndicatorResults.scope(widget.activeChart(),id)?.coverage,id,{timeout:budget.timeoutMs});
        await Promise.allSettled([...pending]);
        if(config.operation==='add') {
          await state.chart.evaluate(id=>widget.activeChart().removeEntity(id),id);
          id=undefined;
        }
      }
      const responseStart=responses.length;
      operation=config.operation==='add' ? await create() : await state.chart.evaluate(({id,inputs})=>{
        const at=performance.now();
        widget.activeChart().getStudyById(id).setInputValues(Object.entries(inputs).map(([id,value])=>({id,value})));
        return {id,at};
      },{id,inputs});
      id=operation.id;
      await wait();
      await Promise.allSettled([...pending]);
      const result=await state.chart.evaluate(({id,at,params,name})=>{
        const fingerprint=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
        const matching=parityCommits.filter(commit=>commit.at>=at && commit.identity.algorithmVersion===name+':1' &&
          fingerprint(JSON.parse(commit.identity.paramsFingerprint))===fingerprint(params));
        const first=matching.find(commit=>commit.finite),covered=matching.find(commit=>commit.visibleRows>=commit.coverage?.count);
        const native=widget.activeChart()._chartWidget.model().model().dataSourceForId(id);
        return {ms:first ? first.at-at : null,coverageMs:covered ? covered.at-at : null,first,covered,
          nativeRows:native?.data().size(),nativeLast:native?.data().last()?.value};
      },{id,at:operation.at,params:spec.params,name:config.indicator});
      const measured=responses.slice(responseStart);
      const study={name:config.indicator,params:spec.params};
      const authority=matchAuthority(result.covered,responses.slice(warmupStart),study,config.kind);
      assert.ok(result.nativeRows && result.coverageMs!==null,'current result has no complete native coverage');
      assert.ok(authority.complete,authority.reason);
      const warmupRequests=responses.slice(warmupStart,responseStart);
      const browserReuse=config.scenario==='loaded-reusable' && !measured.some(response=>
        response.indicators?.some(item=>item.name===study.name && canonical(item.params)===canonical(study.params))) &&
        matchAuthority(result.covered,warmupRequests,study,config.kind).complete;
      const preparation=browserReuse ? validatePreparation(config,warmupRequests,study,result.covered) :
        validatePreparation(config,measured,study);
      assert.ok(preparation.valid,preparation.reason);
      const acceptedTimes=authority.executions.map(execution=>execution.calculation.execution?.input_accepted_at_ms);
      const inputAcceptedAt=acceptedTimes.every(Number.isFinite) ? Math.max(...acceptedTimes) : null;
      samples.push({index:index+1,params:spec.params,...result,authority,preparation,
        canonicalMs:authority.canonicalAt-environment.timeOrigin-operation.at,
        T_input_first:inputAcceptedAt!==null && result.first ? result.first.epochAt-inputAcceptedAt : null,
        inputAcceptedAt,inputTimingReason:inputAcceptedAt===null ? 'durable paged input acceptance not instrumented' :
          'backend frozen prefix and legal seed admitted before computation; browser and API use the same Ubuntu host clock; retained reuse includes time since original acceptance',
        noFiniteOutput:result.ms===null,requests:measured,warmupRequests});
    }catch(cause){error=String(cause);samples.push({index:index+1,params:spec.params,ms:null,coverageMs:null,canonicalMs:null,error,
      requests:responses.slice(warmupStart)});}
    finally{if(id)await state.chart.evaluate(id=>widget.activeChart().removeEntity(id),id).catch(()=>{});}
    console.log({sample:index+1,ms:samples.at(-1).ms,coverageMs:samples.at(-1).coverageMs,error});
  }
}finally{
  await Promise.allSettled([...pending]);
  state.app.off('response',capture);
  await state.chart.evaluate(()=>{
    if(window.parityOriginalApply) MWNativeIndicatorResults.applyBatch=window.parityOriginalApply;
  });
}
const quantile=(key,q)=>{
  const values=samples.map(sample=>sample.error || sample[key]===null ? Infinity : sample[key]).sort((a,b)=>a-b);
  const value=values[Math.ceil(values.length*q)-1];
  return Number.isFinite(value) ? value : null;
};
const metrics=Object.fromEntries(['ms','coverageMs','canonicalMs'].map(key=>[key,{p50:quantile(key,.5),p95:quantile(key,.95)}]));
const failures=samples.filter(sample=>sample.error).length;
const passed=samples.length>=budgets.minimumSamples && !failures && Object.values(metrics).every(metric=>Number.isFinite(metric.p95)) && metrics.ms.p95<budget.firstMs &&
  metrics.coverageMs.p95<budget.coverageMs && metrics.canonicalMs.p95<budget.canonicalMs;
const evidence={recordedAt:new Date().toISOString(),harnessRevision:'execution-evidence-v2',budgetRevision:budgets.revision,scenario:config.scenario,budget,
  source:'actual app / Playwriter / native renderer after two RAFs',synthetic:true,config,environment,
  n:samples.length,failures,quantile:'nearest-rank; failures as infinity (JSON null)',
  ...metrics,passed,samples};
fs.writeFileSync(output,JSON.stringify(evidence,null,2),{flag:'wx'});
console.log(JSON.stringify({...evidence,samples:undefined}));
assert.equal(failures,0,'one or more operations failed; all samples retained');
assert.ok(samples.length>=budgets.minimumSamples,'exploration only; at least 30 independent operations per p95 group');
assert.ok(passed,'declared scenario exceeds its first/coverage/canonical budget');
