// Reject plausible-looking authority from a different execution or partial page.
const assert=require('node:assert/strict');
const {matchAuthority,validatePreparation}=require('./fixtures/indicator-parity-evidence.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const study={name:'EMA',params:{period:500}};
const commit={at:130,epochAt:1130,identity:{main:'MWC:abc',fixedRevision:'rev1',period:'1',
  algorithmVersion:'EMA:1',paramsFingerprint:'{"period":500}',calculationStart:10},
  inputRevision:'2',displaySnapshot:'snapshot1',coverage:{first:50,last:60,count:2},
  sourceRows:[{time:50,sourceTime:50},{time:60,sourceTime:60}]};
const response={at:1120,status:200,query:{instrument:'abc',series_kind:'composite',timeframe:'M1'},
  page:{series_kind:'composite',timeframe:'M1',origin:10,revision_id:'rev1',input_revision:2,
    display_snapshot_id:'snapshot1'},sourceRows:[{start:50,end:60,chart_time:50},{start:60,end:70,chart_time:60}],
  indicators:[{...study,calculation:{canonical_verified:true,visible_complete:true,producer:'backend',
    algorithm:'fixed-indicator-state-v3',calculation_origin:10,input_revision:2,
    coverage:[{start:50,end:70}],required_coverage:[{start:50,end:70}],
    input_evidence:{revision_id:'rev1',input_revision:2,display_snapshot_id:'snapshot1'},
    execution:{result_cache:'miss',input_rows:100,calculation_steps:100,checkpoint_index:0}}}]};
commit.executionEvidence=[clone(response.indicators[0].calculation)];
const matched=matchAuthority(commit,[response],study,'composite');
assert.equal(matched.complete,true);assert.equal(matched.canonicalAt,1130);
for(const mutate of [
  r=>r.query.instrument='other',r=>r.query.series_kind='history',r=>r.page.timeframe='H1',
  r=>r.page.revision_id='rev2',r=>r.page.input_revision=3,r=>r.page.display_snapshot_id='snapshot2',
  r=>r.indicators[0].calculation.input_evidence.display_snapshot_id='stale',
  r=>r.indicators[0].calculation.calculation_origin=20,
  r=>r.indicators[0].calculation.coverage=[{start:50,end:60}],
  r=>r.sourceRows.pop(),r=>r.indicators[0].calculation.canonical_verified=false,
  r=>r.indicators[0].calculation.input_evidence.revision_id='rev0',
  r=>r.indicators[0].calculation.params={period:20},
  r=>r.indicators[0].calculation.algorithm='other-algorithm',
  r=>r.indicators[0].calculation.run_id='other-run',
]){
  const wrong=clone(response);mutate(wrong);
  // The extra params field is not identity; exercise actual spec instead.
  if(wrong.indicators[0].calculation.params)wrong.indicators[0].params=wrong.indicators[0].calculation.params;
  assert.equal(matchAuthority(commit,[wrong],study,'composite').complete,false,JSON.stringify(wrong));
}
const delayed=clone(response);delayed.at=1190;
assert.equal(matchAuthority(commit,[delayed],study,'composite').canonicalAt,1190,'authority receipt can follow render');
const config={scenario:'loaded-new-spec',kind:'composite',prefixRows:100,knownUnused:true};
assert.equal(validatePreparation(config,[response],study).valid,true);
for(const cache of ['hit','checkpoint']){
  const reused=clone(response);reused.indicators[0].calculation.execution.result_cache=cache;
  assert.equal(validatePreparation(config,[reused],study).valid,false,'new-spec must miss both results and checkpoints');
}
const oversize=clone(response);oversize.indicators[0].calculation.execution.input_rows=101;
assert.equal(validatePreparation(config,[oversize],study).valid,false);
const reusable={...config,scenario:'loaded-reusable',prewarm:true};
assert.equal(validatePreparation(reusable,[response],study).valid,false,'input hit alone cannot prove reusable result');
const hit=clone(response);hit.indicators[0].calculation.execution.result_cache='hit';
Object.assign(hit.indicators[0].calculation.execution,{calculation_steps:0,checkpoint_index:0});
assert.equal(validatePreparation(reusable,[hit],study).valid,true);
const suffix=clone(hit);Object.assign(suffix.indicators[0].calculation.execution,{result_cache:'checkpoint',calculation_steps:513});
assert.equal(validatePreparation(reusable,[suffix],study).valid,false);
const durable=clone(hit);
durable.indicators[0].calculation.execution={path:'durable-fixed',input_rows:100,result_cache:'checkpoint',calculation_steps:0};
assert.equal(validatePreparation(reusable,[durable],study).valid,false,
  'HTTP work of zero cannot prove a bounded durable-worker suffix');
console.log('PASS parity evidence: execution/snapshot/revision/origin/coverage and cache preparation fences');
