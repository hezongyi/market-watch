const assert=require('assert').strict,fs=require('node:fs');
assert.ok(!state.recoveryRoute,'previous gate must be removed');
state.recoveryPeriod=141+state.recoveryResults.length;
state.recoveryResponseStart=state.recoveryResponses.length;
state.recoveryBefore=await state.chart.evaluate(()=>{
  const c=widget.activeChart(),key=indicatorKey(c.symbol(),c.resolution()),b=indicatorBindings.get(key),p=displayRecoveries.get(key);
  window.recoveryPreviousEntry=p;
  return {key,token:b?.displaySnapshot,revision:b?.revision,previousToken:p?.token,previousState:p?.state,
    readyForSameToken:p?.state==='ready'&&p.token===b?.displaySnapshot,at:Date.now()};
});
state.recoveryHeld=null;
state.recoveryGate=new Promise(resolve=>state.recoveryRelease=resolve);
state.recoveryRoute=async route=>{
  const q=route.request().postDataJSON();
  if(!state.recoveryHeld&&q?.indicators?.some(s=>s.name==='BBANDS'&&s.params.period===state.recoveryPeriod)){
    state.recoveryHeld={token:q.display_snapshot_id,revision:q.composite_revision_id,instrument:q.instrument,
      kind:q.series_kind,timeframe:q.timeframe,period:state.recoveryPeriod};
    await state.recoveryGate;
  }
  await route.continue().catch(()=>{});
};
await state.app.route('**/api/charts/data',state.recoveryRoute);
state.recoveryStudy=await state.chart.evaluate(period=>widget.activeChart().createStudy('守望 Python BBANDS',false,false,{period,deviation:2.731}),state.recoveryPeriod);
// Yield through the real browser instead of a blind sleep; keep the HTTP held
// while the task-owned database expires this exact synthetic snapshot.
for(let i=0;i<100&&!state.recoveryHeld;i++)await state.app.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
assert.ok(state.recoveryHeld,'target indicator HTTP was not captured');
assert.equal(state.recoveryHeld.token,state.recoveryBefore.token);
assert.equal(state.recoveryHeld.revision,state.recoveryBefore.revision);
fs.writeFileSync('/tmp/mw-issue74-20261017/recovery-held-v4-'+state.recoveryPeriod+'.json',JSON.stringify(state.recoveryHeld,null,2),{flag:'wx'});
console.log({held:state.recoveryHeld,before:state.recoveryBefore});
