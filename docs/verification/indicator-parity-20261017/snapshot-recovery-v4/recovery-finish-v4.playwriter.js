const assert=require('assert').strict,fs=require('node:fs');
try{
  state.recoveryRelease();
  await state.chart.waitForFunction(({id,period})=>{
    const c=widget.activeChart(),key=indicatorKey(c.symbol(),c.resolution()),entry=displayRecoveries.get(key),scope=MWNativeIndicatorResults.scope(c,id);
    return entry&&entry!==recoveryPreviousEntry&&entry.state==='ready'&&scope?.coverage&&!scope.transition&&
      JSON.parse(JSON.parse(scope.coverage.identity).paramsFingerprint).period===period&&
      recoveryCommits.some(x=>x.identity.algorithmVersion==='BBANDS:1'&&JSON.parse(x.identity.paramsFingerprint).period===period);
  },{id:state.recoveryStudy,period:state.recoveryPeriod},{timeout:20000});
  await Promise.allSettled([...state.recoveryPending]);
  const after=await state.chart.evaluate(({id,period})=>{
    const c=widget.activeChart(),key=indicatorKey(c.symbol(),c.resolution()),b=indicatorBindings.get(key),e=displayRecoveries.get(key);
    const native=c._chartWidget.model().model().dataSourceForId(id);
    const commit=recoveryCommits.filter(x=>x.identity.algorithmVersion==='BBANDS:1'&&JSON.parse(x.identity.paramsFingerprint).period===period).at(-1);
    return {token:b.displaySnapshot,recoveryToken:e.token,state:e.state,entryReplaced:e!==recoveryPreviousEntry,
      nativeRows:native.data().size(),nativeLast:native.data().last()?.value,commit,at:Date.now()};
  },{id:state.recoveryStudy,period:state.recoveryPeriod});
  const responses=state.recoveryResponses.slice(state.recoveryResponseStart);
  fs.writeFileSync('/tmp/mw-issue74-20261017/recovery-observed-v4-'+state.recoveryPeriod+'.json',JSON.stringify({before:state.recoveryBefore,held:state.recoveryHeld,after,responses},null,2),{flag:'wx'});
  assert.ok(responses.some(r=>r.status===422&&r.detail?.code==='DISPLAY_SNAPSHOT_EXPIRED'),'real expiry response absent');
  assert.ok(responses.some(r=>r.status===200&&!r.query.indicators?.length&&r.page.display_snapshot_id),'fresh parent-price response absent');
  const authority=state.recoveryEvidence.matchAuthority(after.commit,responses,{name:'BBANDS',params:{period:state.recoveryPeriod,deviation:2.731}},'composite');
  assert.ok(authority.complete,authority.reason);assert.ok(after.nativeRows>0);assert.ok(after.commit.finite>0);
  const result={period:state.recoveryPeriod,before:state.recoveryBefore,held:state.recoveryHeld,after,authority,responses,passed:true};
  state.recoveryResults.push(result);
  fs.writeFileSync('/tmp/mw-issue74-20261017/recovery-result-v4-'+state.recoveryPeriod+'.json',JSON.stringify(result,null,2),{flag:'wx'});
  console.log({period:result.period,passed:true,readyForSameToken:result.before.readyForSameToken,sameToken:result.before.token===after.token,nativeRows:after.nativeRows,requests:responses.map(r=>({status:r.status,detail:r.detail}))});
}finally{
  state.recoveryRelease();
  await state.app.unroute('**/api/charts/data',state.recoveryRoute);state.recoveryRoute=null;
  if(state.recoveryStudy)await state.chart.evaluate(id=>widget.activeChart().removeEntity(id),state.recoveryStudy).catch(()=>{});
}
