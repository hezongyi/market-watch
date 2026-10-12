const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 const settle=()=>p.host.waitForFunction(()=>!loading&&!pending.size&&!requests.length&&!rangeGuard.busy()&&!edgeGuard.busy()&&!MWNativeNavigation.busy()&&widget.activeChart().dataReady(),null,{timeout:90000});
 try {
  await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('s');widget.activeChart().removeAllStudies();widget.activeChart().setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');});await settle();await p.host.evaluate(()=>widget.activeChart().setResolution('5',{doNotActivateChart:true}));await settle();
  await p.ui.getByRole('button',{name:'指标',exact:true}).click();await p.ui.getByRole('button',{name:'我的 Python',exact:true}).click();await p.ui.locator('.mw-native-study-row[data-native-study-id="MWPythonSMA@market-watch"] [role="option"]').click();await p.ui.getByRole('button',{name:'关闭指标窗口',exact:true}).click();
  await p.host.waitForFunction(()=>widget.activeChart().getAllStudies().some(s=>s.name==='守望 Python SMA'),null,{timeout:30000});
  const id=await p.host.evaluate(()=>{const c=widget.activeChart(),id=c.getAllStudies().find(s=>s.name==='守望 Python SMA').id;c.getStudyById(id).setInputValues([{id:'period',value:200}]);return id;});
  await p.host.waitForFunction(()=>nativeReserveWarmup(widget.activeChart().symbol(),widget.activeChart().resolution())>=200,null,{timeout:30000});await settle();
  const read=()=>p.host.evaluate(id=>{const c=widget.activeChart(),s=c._chartWidget.model().model().dataSourceForId(id),ts=c.getTimeScale();return{symbol:c.symbol(),resolution:c.resolution(),range:c.getVisibleRange(),spacing:ts.barSpacing(),warmup:nativeReserveWarmup(c.symbol(),c.resolution()),inputs:c.getStudyById(id).getInputValues(),plots:s.data().size(),reserve:MWNativeReserve.diagnostics()};},id);
  await p.host.waitForFunction(id=>widget.activeChart()._chartWidget.model().model().dataSourceForId(id).data().size()>0,id,{timeout:90000});const before=await read();
  // Small cached pan remains synchronous while the study retains its prefix.
  await p.host.evaluate(()=>{const ts=widget.activeChart().getTimeScale();ts.setRightOffset(ts.rightOffset()-10);});await p.page.waitForTimeout(100);const after=await read();assert.equal(after.spacing,before.spacing);assert.equal(after.warmup,200);assert.ok(after.plots>0);assert.equal(after.symbol,before.symbol);r.cases.push({name:'real Python SMA200 prewarm, native cached pan and reserve prefix',before,after});
  // Delay the actual fixed-read HTTP lane and measure the slow-load tier.
  await p.page.route('**/api/charts/data',async route=>{const q=route.request().postDataJSON();if(q.series_kind==='composite')await new Promise(ok=>setTimeout(ok,900));try{return await route.continue();}catch{return;}});
  await p.host.evaluate(()=>widget.activeChart().setResolution('15',{doNotActivateChart:true}));await settle();
  const delayed=await read();assert.ok(delayed.reserve.models.some(m=>m.state.enhancedUntil>0));assert.equal(delayed.spacing,before.spacing);r.cases.push({name:'controlled 900ms actual fixed HTTP delay activates enhanced reserve without changing column width',state:delayed});await p.page.unrouteAll({behavior:'wait'});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-reserve-indicator.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
