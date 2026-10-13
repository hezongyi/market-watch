const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const timers=new Set(),context={setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn)};
vm.runInNewContext(fs.readFileSync('../advanced-host/composite-display-batches.js','utf8'),context);
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
const event=(sequence,...minutes)=>({sequence,display_snapshot_id:'snapshot-'+sequence,
 bars:minutes.map(start=>({start,close:sequence}))});
(async()=>{
 const accepted=[],reports=[],pending=[];
 const gate=context.chartDisplayBatches({accept:(owner,e)=>accepted.push({owner,event:e}),
  settle:(key,current)=>new Promise(resolve=>pending.push({resolve,current})),
  report:(key,error,reload)=>reports.push({key,error,reload}),maxBars:2});
 const owner={};
 try{
  gate.enqueue('A',owner,event(1,1),()=>true);await flush();
  gate.enqueue('A',owner,event(2,2),()=>true);
  gate.cancel('A');assert.equal(pending[0].current(),false);
  gate.enqueue('A',owner,event(3,3),()=>true);await flush();
  assert.deepEqual(accepted.map(v=>v.event.sequence),[1,3],'reset discards the old queued minute immediately');
  pending[0].resolve();await flush();assert.deepEqual(accepted.map(v=>v.event.sequence),[1,3]);
  gate.enqueue('A',owner,event(4,4),()=>true);
  for(const fn of [...timers])fn();await flush();
  assert.deepEqual(accepted.map(v=>v.event.sequence),[1,3,4],'a stalled study cannot hold prices forever');
  assert.equal(reports[0].reload,false);assert.equal(pending[1].current(),false);
  gate.enqueue('A',owner,event(5,5,6),()=>true);
  gate.enqueue('A',owner,event(6,7),()=>true);
  assert.equal(reports.at(-1).reload,true,'capacity failure requests explicit history recovery');
  assert.equal(gate.diagnostics().queued,0,'capacity failure cannot retain an unbounded queue');
  gate.enqueue('A',owner,event(7,7),()=>false);await flush();assert.equal(accepted.length,3);
 }finally{gate.dispose();}
 const a={},b={},same=[],held=[];
 const panes=context.chartDisplayBatches({owners:()=>[a,b],accept:(owner,e)=>same.push({owner,event:e}),
  settle:()=>new Promise(resolve=>held.push(resolve)),maxBars:6});
 try{
  panes.enqueue('shared',a,event(1,1),()=>true);await flush();
  assert.equal(same.length,2);assert.equal(same[0].event.display_snapshot_id,same[1].event.display_snapshot_id);
  panes.enqueue('shared',a,event(2,1,2),()=>true);
  panes.enqueue('shared',b,event(3,2,3),()=>true);
  held.shift()();await flush();
  assert.equal(same.length,4);assert.equal(same[2].event.display_snapshot_id,'snapshot-3');
  assert.equal(same[3].event.display_snapshot_id,'snapshot-3');
  assert.deepEqual(Array.from(same[2].event.bars,b=>b.start),[1,2,3]);
  assert.equal(same[2].event.bars[1].close,3,'latest real candle replaces earlier observation');
 }finally{panes.dispose();}
 const failed=[];
 const broken=context.chartDisplayBatches({accept:()=>{throw Error('native failure');},settle:()=>{},
  report:(key,error,reload)=>failed.push({error,reload})});
 broken.enqueue('broken',{},event(1,1),()=>true);await flush();
 assert.equal(failed.length,1);assert.equal(failed[0].reload,true);assert.equal(broken.diagnostics().lanes,0);broken.dispose();
 console.log('PASS display batches: cancellation, timeout, bounded capacity, shared panes and acceptance failure recovery');
})().catch(error=>{console.error(error);process.exitCode=1;});
