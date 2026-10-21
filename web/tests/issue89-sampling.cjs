const assert=require('node:assert/strict');
const {sampleNative,withinDeadline}=require('./fixtures/issue89-sampling.cjs');

async function scenario(change){
  let clock=0,version=1,reads=0,references=0,comparisons=0;
  const events=[];
  const result=await sampleNative({deadline:100,now:()=>clock,pause:async ms=>{clock+=ms;},
    read:async()=>{reads++;return {eligible:true,fingerprint:JSON.stringify(version),version,summary:{version}};},
    reference:async(candidate,remaining)=>{
      assert.equal(remaining,100-clock);references++;clock+=10;
      version=change({version,references});return {version:candidate.version};
    },
    compare:(candidate,expected)=>{comparisons++;assert.deepEqual(candidate.version,expected.version);return {mismatches:0};},
    record:event=>events.push(event),
  });
  return {result,reads,references,comparisons,clock,events};
}
(async()=>{
  for(const changed of [2,{generation:1,main:'new-price'}]){
    const run=await scenario(({version,references})=>references===1?changed:version);
    assert.equal(run.references,2);assert.equal(run.comparisons,1);
    assert.equal(run.events.filter(x=>x.event==='invalidated').length,1);
  }
  await assert.rejects(scenario(({version})=>version+1),/deadline exhausted/);
  let calls=0;
  await assert.rejects(sampleNative({deadline:Date.now()+1000,
    read:async()=>({eligible:true,fingerprint:'fixed',summary:{}}),
    reference:async()=>{calls++;return {};},
    compare:()=>{throw Error('stable wrong values or incomplete coverage');},
  }),/stable wrong values/);
  assert.equal(calls,1,'correctness errors cannot be swallowed by resampling');
  let clock=0;
  await assert.rejects(sampleNative({deadline:100,now:()=>clock,pause:async ms=>{clock+=ms;},
    read:async()=>({eligible:false,reason:'current generation has no accepted batch',summary:{}}),
    reference:()=>assert.fail('no reference without acceptance'),compare:()=>assert.fail(),
  }),/deadline exhausted: current generation/);
  assert.equal(clock,100,'waiting does not renew the stage deadline');
  await assert.rejects(sampleNative({deadline:Date.now()+20,
    read:async()=>({eligible:true,fingerprint:'fixed',summary:{}}),
    reference:()=>new Promise(()=>{}),compare:()=>assert.fail(),
  }),/deadline exhausted/);
  await assert.rejects(withinDeadline(Date.now()+20,
    ()=>Promise.all([new Promise(()=>{})]),{reason:'response body never completed'}),
  /deadline exhausted: response body never completed/);
  let started=false;
  await assert.rejects(withinDeadline(100,()=>{started=true;},{now:()=>100}),/deadline exhausted/);
  assert.equal(started,false,'expired setup budget cannot begin another operation');
  console.log('PASS native sampling: generation/price races, fixed deadline, stalled read and stable correctness failures');
})().catch(e=>{console.error(e);process.exitCode=1;});
