const assert=require('assert').strict,fs=require('node:fs');
const oldToken=state.recoveryResults[0].before.token;
const previousToken=state.recoveryResults.at(-1).after.recoveryToken;
assert.notEqual(oldToken,previousToken);
assert.equal(await state.chart.evaluate(()=>reloadHistory(widget.activeChart().symbol(),widget.activeChart().resolution())),true);
await state.chart.waitForFunction(previous=>indicatorBindings.get(indicatorKey(widget.activeChart().symbol(),'1'))?.displaySnapshot!==previous,previousToken,{timeout:10000});
const id=await state.chart.evaluate(()=>widget.activeChart().createStudy('守望 Python BBANDS',false,false,{period:153,deviation:2.731}));
try{
  await state.chart.waitForFunction(id=>MWNativeIndicatorResults.scope(widget.activeChart(),id)?.coverage,id,{timeout:10000});
  await state.chart.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const sample=()=>state.chart.evaluate(id=>{
    const c=widget.activeChart(),key=indicatorKey(c.symbol(),'1'),b=indicatorBindings.get(key),e=displayRecoveries.get(key),native=c._chartWidget.model().model().dataSourceForId(id);
    return {token:b.displaySnapshot,revision:b.revision,recoveryToken:e.token,recoveryState:e.state,
      sameRecoveryEntry:e===window.recoveryStaleEntry,subscriptions:[...subscriptions.values()].filter(s=>indicatorKey(s.symbol,s.res)===key).map(s=>({generation:s.marketGeneration,needsHistoryReload:s.needsHistoryReload})),
      rows:native.data().size(),last:native.data().last()?.value,scope:MWNativeIndicatorResults.scope(c,id),at:Date.now()};
  },id);
  await state.chart.evaluate(()=>{window.recoveryStaleEntry=displayRecoveries.get(indicatorKey(widget.activeChart().symbol(),'1'));});
  const before=await sample();
  assert.equal(before.recoveryToken,previousToken);assert.notEqual(before.token,previousToken);assert.notEqual(before.token,oldToken);
  const responseStart=state.recoveryResponses.length;
  const error=await state.chart.evaluate(async({token,revision})=>{
    try{await query(widget.activeChart().symbol(),'1',{display_snapshot_id:token,composite_revision_id:revision,limit:2});return null;}
    catch(error){return {code:error.code,message:error.message};}
  },{token:oldToken,revision:before.revision});
  assert.equal(error?.code,'DISPLAY_SNAPSHOT_EXPIRED');
  await state.chart.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await Promise.allSettled([...state.recoveryPending]);
  const after=await sample(),responses=state.recoveryResponses.slice(responseStart);
  assert.ok(responses.some(r=>r.status===422&&r.query.display_snapshot_id===oldToken&&r.detail?.code===error.code));
  assert.ok(after.sameRecoveryEntry);assert.equal(after.token,before.token);assert.equal(after.recoveryToken,before.recoveryToken);
  assert.deepEqual(after.subscriptions,before.subscriptions);assert.equal(after.rows,before.rows);assert.deepEqual(after.last,before.last);
  assert.deepEqual(after.scope,before.scope);
  assert.equal(responses.filter(r=>r.status===200&&!r.query.indicators?.length).length,0,'obsolete token must not start a price reload');
  const result={source:'actual bridge query, real app HTTP 422, three distinct content-addressed tokens',oldToken,before,after,error,responses,passed:true,
    limit:'the request intentionally uses an obsolete token after accepting the new binding; it does not simulate a physically delayed in-flight response'};
  fs.writeFileSync('/tmp/mw-issue74-20261017/recovery-stale-http-v4.json',JSON.stringify(result,null,2),{flag:'wx'});
  console.log({passed:true,distinctTokens:3,oldError:error.code,unchangedNativeRows:after.rows,recoveryEntryPreserved:after.sameRecoveryEntry,noPriceReload:true});
}finally{await state.chart.evaluate(id=>widget.activeChart().removeEntity(id),id).catch(()=>{});}
