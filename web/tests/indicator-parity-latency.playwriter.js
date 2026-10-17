// Run with Playwriter -s SESSION -f FILE. Uses the task's authenticated app tab.
const fs = require('node:fs');
const assert = require('assert').strict;
assert.ok(state.chart && state.app, 'open the isolated app first');
console.log(await snapshot({page:state.app}));
await state.chart.evaluate(() => {
  widget.activeChart().getAllStudies().forEach(study => widget.activeChart().removeEntity(study.id));
  window.parityCommits = [];
  if (!window.parityOriginalApply) {
    window.parityOriginalApply = MWNativeIndicatorResults.applyBatch;
    MWNativeIndicatorResults.applyBatch = async (handle,batch) => {
      const accepted = await parityOriginalApply(handle,batch);
      if (accepted) {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        parityCommits.push({at:performance.now(),identity:handle.identity,coverage:batch.coverage,
          finite:batch.rows.filter(row => row.valid.some(Boolean)).length});
      }
      return accepted;
    };
  }
});
console.log(await getLatestLogs({page:state.app,sinceLastCall:true}));
const samples = [];
for(let sample = 0; sample < 30; sample++) {
  const period = 31 + sample;
  const operation = await state.chart.evaluate(async period => {
    window.parityCommits = [];
    const at = performance.now();
    const id = await widget.activeChart().createStudy('守望 Python LWMA',false,false,{period});
    return {id,at};
  },period);
  let error;
  try {
    await state.chart.waitForFunction(period => parityCommits.some(commit =>
      commit.finite && JSON.parse(commit.identity.paramsFingerprint).period === period),period,{timeout:5000});
  } catch(cause) {error = String(cause);}
  const result = await state.chart.evaluate(({period,operation}) => {
    const commit = parityCommits.find(commit => commit.finite && JSON.parse(commit.identity.paramsFingerprint).period === period);
    const native = widget.activeChart()._chartWidget.model().model().dataSourceForId(operation.id);
    return {period,ms:commit ? commit.at - operation.at : null,commit,
      nativeRows:native?.data().size(),nativeLast:native?.data().last()?.value};
  },{period,operation});
  samples.push({...result,error});
  await state.chart.evaluate(id => widget.activeChart().removeEntity(id),operation.id);
  console.log(await getLatestLogs({page:state.app,sinceLastCall:true}));
  console.log({sample:sample+1,ms:result.ms,error});
}
const values = samples.map(sample => sample.ms ?? Infinity).sort((a,b) => a-b);
const evidence = {phase:state.phase || 'baseline',synthetic:true,source:'actual app / Playwriter / native renderer',
  kind:'managed',operation:'add',indicator:'LWMA',parameters:'30 previously unused periods',
  n:samples.length,failures:samples.filter(sample => sample.error || !sample.nativeRows).length,
  quantile:'nearest-rank, failures included as infinity',p50:values[Math.ceil(values.length*.5)-1],
  p95:values[Math.ceil(values.length*.95)-1],target:300,samples};
fs.writeFileSync('/tmp/mw-issue74-20261017/latency-'+evidence.phase+'.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
assert.equal(evidence.failures,0,'first current-parameter value did not render');
assert.ok(evidence.p95 < evidence.target,'add current-parameter first visible value exceeds 300 ms p95');
