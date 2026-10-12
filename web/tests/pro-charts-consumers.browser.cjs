const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 try {
  await p.host.evaluate(()=>{widget.activeChart().removeAllStudies();widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.timeSync().setValue(false);widget.dateRangeSync().setValue(false);widget.setLayout('2h');});await p.host.waitForFunction(()=>widget.chartsCount()===2);
  await p.host.evaluate(async()=>{for(let i=0;i<2;i++)await widget.chart(i).setSymbol('MWP:EURUSD',{doNotActivateChart:true});});
  await p.host.waitForFunction(()=>[0,1].every(i=>widget.chart(i).dataReady()),null,{timeout:60000});
  const id=await p.host.evaluate(()=>widget.chart(1).createStudy('Compare',true,false,{symbol:'MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c'},undefined,{priceScale:'new-left'}));
  await p.host.waitForFunction(id=>widget.chart(1).getAllStudies().some(s=>s.id===id),id);
  await p.host.evaluate(()=>widget.setLayout('s'));await p.host.waitForFunction(()=>widget.chartsCount()===1);
  await p.host.evaluate(()=>widget.setLayout('2h'));await p.host.waitForFunction(()=>widget.chartsCount()===2&&[0,1].every(i=>widget.chart(i).dataReady()),null,{timeout:60000});
  const comparison=await p.host.evaluate(id=>({studies:widget.chart(1).getAllStudies(),tracked:hasHistoryViewer({instrument:'MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c',timeframe:frames[widget.chart(1).resolution()]}),inputs:widget.chart(1).getStudyById(id).getInputValues()}),id);
  assert.ok(comparison.tracked);assert.ok(comparison.inputs.some(x=>x.value==='MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c'));r.cases.push({name:'real fixed comparison consumer survives hidden layout roundtrip',comparison});
  console.log('COMPARE_PASS');
  let fault=true;await p.page.route('**/api/charts/data',route=>{const q=route.request().postDataJSON();if(fault&&q.series_kind==='history'&&q.timeframe==='H4'){fault=false;console.log('FAULT_H4');return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'isolated acceptance single request failure'})});}return route.continue();});
  await p.host.waitForFunction(()=>!rangeGuard.busy()&&!edgeGuard.busy()&&!MWNativeNavigation.busy()&&!pending.size&&!requests.length&&MWNativeReserve.diagnostics().flights===0,null,{timeout:60000});
  console.log('PEER_SETTLED');
  const peer=await p.host.evaluate(()=>({symbol:widget.chart(0).symbol(),resolution:widget.chart(0).resolution(),range:widget.chart(0).getVisibleRange()}));
  await p.host.evaluate(()=>{widget.chart(1).removeAllStudies();widget.chart(1).setSymbol('MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c');widget.chart(1).setResolution('240');});
  await p.host.waitForFunction(()=>MWNativeNavigation.failure(widget.chart(1)),null,{timeout:60000});
  const failure=await p.host.evaluate(()=>String(MWNativeNavigation.failure(widget.chart(1))));assert.match(failure,/503|isolated/);
  const retry=p.page.getByRole('button',{name:'重试此图格',exact:true});await p.expect(retry).toBeVisible();await retry.click();
  await p.host.waitForFunction(()=>widget.chart(1).dataReady()&&widget.chart(1).getVisibleRange().to>widget.chart(1).getVisibleRange().from,null,{timeout:60000});
  assert.deepEqual(await p.host.evaluate(()=>({symbol:widget.chart(0).symbol(),resolution:widget.chart(0).resolution(),range:widget.chart(0).getVisibleRange()})),peer);r.cases.push({name:'injected one-load 503 and actual UI per-pane retry preserves peer',failure,peer});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;r.state=await p.host.evaluate(()=>({loading,pending:pending.size,queued:requests.length,range:rangeGuard.busy(),edge:edgeGuard.busy(),navigation:MWNativeNavigation.diagnostics(),reserve:MWNativeReserve.diagnostics(),charts:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),ready:widget.chart(i).dataReady()}))}));throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-consumers.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
