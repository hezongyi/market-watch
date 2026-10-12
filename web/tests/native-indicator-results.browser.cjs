// Stage A: real Python LWMA batches through the pinned native consumer/renderer.
// Product range coordination, multi-output and Docker acceptance are separate gates.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),host=path.join(root,'advanced-host'),origin='https://mw-results.invalid';
const input=JSON.parse(execFileSync(path.join(root,'.venv/bin/python'),['-c',`
import json,math
from alerts.chart_indicators import public_catalog,calculate
end=1790640000000; step=86400000
rows=[]
for i in range(1000):
 t=end-(1000-i)*step; value=100+math.sin(t/step)*2
 rows.append(dict(start=t,end=t+step,open=value,high=value+2,low=value-2,close=value+1,complete=True))
print(json.dumps(dict(catalog={k:public_catalog()[k] for k in ["LWMA","SWING_SR_V1","SUPERTREND_PINE_V1"]},bars=rows,result=calculate(rows,{"name":"LWMA","params":{"period":5}}),lwma7=calculate(rows,{"name":"LWMA","params":{"period":7}}),swing=calculate(rows,{"name":"SWING_SR_V1"}),supertrend=calculate(rows,{"name":"SUPERTREND_PINE_V1"}))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')}}));
(async()=>{
 const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let html=fs.readFileSync(path.join(__dirname,'fixtures/native-history.html'),'utf8')
    .replace('<script>','<script src="/indicators.js"></script><script src="/native-indicator-results.js"></script><script src="/indicator-coordinator.js"></script><script>')
    .replace('const widget=new TradingView.widget(',`MWNativeIndicatorResults.configure(${JSON.stringify(input.catalog)},{enable:true});const widget=new TradingView.widget(`)
    .replace("symbol:'TEST',interval:",`custom_indicators_getter:async PineJS=>pythonStudies(PineJS,${JSON.stringify(input.catalog)}),symbol:'TEST',interval:`);
  await page.route('**/*',r=>{
   const u=new URL(r.request().url());if(u.origin!==origin)return r.fulfill({status:204,body:''});
   if(u.pathname==='/product') {
    const fixture=html.replace('<script src="/indicators.js">','<script src="/series.js"></script><script src="/swing-sr-display.js"></script><script src="/bridge.js"></script><script src="/indicators.js">')
      .replaceAll('subscriptions','fixtureSubscriptions').replace('const feed=','const fixtureFeed=').replace('datafeed:feed','datafeed:fixtureFeed')
      .replace('const widget=new TradingView.widget(','widget=new TradingView.widget(').replace('let ready=false;','ready=false;');
    return r.fulfill({contentType:'text/html; charset=utf-8',body:fixture});
   }
   if(u.pathname==='/')return r.fulfill({contentType:'text/html; charset=utf-8',body:html});
   const file=path.resolve(host,'.'+u.pathname);
   if(!file.startsWith(host+'/') || !fs.existsSync(file))return r.fulfill({status:404});
   let body=fs.readFileSync(file);
   if(file.endsWith('library.e2f8b3a016c9e1a0b7a5.js'))body=body.toString().replace(
    '_createStudy(e,t,i,s,r,o,a,l){this._studiesCache[s][r].completed=!1;',
    '_createStudy(e,t,i,s,r,o,a,l){if(globalThis.parent?.MWNativeIndicatorResults?.start(this,e,t,i,s,r,o,a,l))return;this._studiesCache[s][r].completed=!1;');
   return r.fulfill({contentType:file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':'application/octet-stream',body});
  });
  await page.goto(origin+'/?initialCount=1000');await page.waitForFunction(()=>ready&&widget.activeChart().dataReady());
  const id=await page.evaluate(()=>widget.activeChart().createStudy('守望 Python LWMA',false,false));
  const rows=input.result.series[0].values.map(row=>({time:row.time,values:[row.value],valid:[row.value!==null]}));
  const before=await page.evaluate(id=>{
   const chart=widget.activeChart(),study=chart._chartWidget.model().model().dataSourceForId(id);
   const handle=MWNativeIndicatorResults.attach(chart,id,{main:'TEST',fixedRevision:'fixture-1',
    paramsFingerprint:'{"period":5}',algorithmVersion:'1',calculationStart:probe.end-1000*probe.day});
   window.handle=handle;window.resultId=id;
   return {size:study.data().size(),inputs:chart.getStudyById(id).getInputValues(),defaults:chart.getStudyById(id).getStyleValues()};
  },id);
  assert.equal(before.size,0,'external mode must not start an auxiliary-series calculation');
  async function submit(rows,sequence,revision='1',kind='snapshot',range){return page.evaluate(async args=>
    MWNativeIndicatorResults.applyBatch(handle,{...args,identity:handle.identity,generation:handle.generation,inputRevision:args.revision}),
    {rows,sequence,revision,kind,...(range?{range}:{})});}
  assert.equal(await submit(rows,1),true);
  const read=()=>page.evaluate(()=>{
   const chart=widget.activeChart(),study=chart._chartWidget.model().model().dataSourceForId(resultId);
   return {size:study.data().size(),first:study.data().first(),last:study.data().last(),range:study.priceScale().priceRange()?.toRaw?.()};
  });
  const accepted=await read();assert.ok(accepted.size>100,JSON.stringify(accepted));
  assert.ok(Math.abs(accepted.last.value[1]-rows.at(-1).values[0])<1e-10);
  assert.equal(await submit(rows.map(row=>({...row,values:[999]})),0),false,'out-of-order sequence rejected');
  const corrected=rows.map(row=>({...row,values:[row.values[0]]}));corrected.at(-1).values=[0];
  assert.equal(await submit(corrected,2,'2'),true);assert.equal((await read()).last.value[1],0,'zero is a valid output');
  corrected.at(-1).values=[-2];assert.equal(await submit(corrected,3,'3'),true);assert.equal((await read()).last.value[1],-2);
  corrected.at(-1).valid=[false];assert.equal(await submit(corrected,4,'4'),true);assert.equal((await read()).last.value[1],null,'invalid retracts old finite value');
  assert.equal(await submit(rows,5,'3'),false,'older input revision rejected');
  assert.equal(await submit(rows.slice(0,-2),6,'5'),true);assert.equal((await read()).size,accepted.size-2,'snapshot shortening really removes tail');
  assert.equal(await submit([],7,'6'),true);assert.equal((await read()).size,0,'empty snapshot really removes all rows');
  assert.equal(await submit(rows,8,'7'),true);
  await page.evaluate(()=>{
    const previous=handle;
    handle=MWNativeIndicatorResults.attach(widget.activeChart(),resultId,{...previous.identity,algorithmVersion:'2'});
    MWNativeIndicatorResults.detach(previous);
  });
  assert.equal(await submit(rows,1,'8'),true,'late detach from an old generation preserves the new binding');
  await page.evaluate(()=>widget.activeChart().removeEntity(resultId));
  assert.equal(await submit(rows,9,'8'),false,'removed study rejects a late batch');
  // Stage B coordination over the accepted main range. Two identical instances
  // share one Python response and retain curves during a pending preparation.
  await page.evaluate(async ({catalog,result,bars})=>{
    const chart=widget.activeChart();
    window.coordinated=await Promise.all([chart.createStudy('守望 Python LWMA',false,false),chart.createStudy('守望 Python LWMA',false,false)]);
    window.coordinatorReads=0;window.coordinatorErrors=[];window.testRevision=1;window.testCorrection=0;window.gatedRead=null;window.releaseRead=null;
    window.coordinator=chartIndicatorCoordinator(widget,catalog,{
      identity:{binding:()=>({revision:'fixture-1',inputRevision:testRevision,correctionVersion:testCorrection,calculationStart:probe.end-1000*probe.day}),chartTime:bar=>bar.start},
      read:async()=>{coordinatorReads++;if(gatedRead)await gatedRead;return {bars,indicators:[result],input_revision:testRevision,has_more:false};},
      report:error=>coordinatorErrors.push(String(error)),
    });
    await coordinator.sync();
  },input);
  await expect.poll(()=>page.evaluate(()=>coordinated.map(id=>widget.activeChart()._chartWidget.model().model().dataSourceForId(id).data().size()).every(n=>n>100))).toBe(true);
  assert.equal(await page.evaluate(()=>coordinatorReads),1,'identical instances share a Python range read');
  assert.deepEqual(await page.evaluate(()=>coordinatorErrors),[]);
  await page.evaluate(()=>{gatedRead=new Promise(resolve=>releaseRead=resolve);testRevision=2;void coordinator.sync();});
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>coordinated.every(id=>widget.activeChart()._chartWidget.model().model().dataSourceForId(id).data().size()>100)),true,'waiting for ordinary progress retains valid curves');
  await page.evaluate(()=>{releaseRead();gatedRead=null;});
  await page.waitForTimeout(100);
  await page.evaluate(()=>{gatedRead=new Promise(resolve=>releaseRead=resolve);testCorrection=1;testRevision=3;void coordinator.sync();});
  await expect.poll(()=>page.evaluate(()=>coordinated.every(id=>widget.activeChart()._chartWidget.model().model().dataSourceForId(id).data().size()===0))).toBe(true);
  await page.evaluate(()=>{releaseRead();gatedRead=null;});
  await expect.poll(()=>page.evaluate(()=>coordinated.every(id=>widget.activeChart()._chartWidget.model().model().dataSourceForId(id).data().size()>100))).toBe(true);
  await page.evaluate(()=>coordinator.dispose());
  // Multi-output profiles share the same result adapter, with atomic plots.
  await page.evaluate(async ({catalog,bars,swing,supertrend,lwma7})=>{
    for(const id of coordinated)widget.activeChart().removeEntity(id);
    window.multiIds=[];window.multiErrors=[];window.multiReads=0;
    for(const name of ['SWING_SR_V1','SUPERTREND_PINE_V1','LWMA'])multiIds.push(await widget.activeChart().createStudy('守望 Python '+name,false,false,name==='LWMA'?{period:7}:undefined));
    window.multiCoordinator=chartIndicatorCoordinator(widget,catalog,{
      identity:{binding:()=>({revision:'fixture-1',inputRevision:1,calculationStart:probe.end-1000*probe.day}),chartTime:bar=>bar.start},
      read:async(symbol,res,args)=>{multiReads++;return {bars,indicators:args.indicators.map(spec=>({SWING_SR_V1:swing,SUPERTREND_PINE_V1:supertrend,LWMA:lwma7}[spec.name])),input_revision:1,has_more:false};},
      report:error=>multiErrors.push(String(error)),
    });await multiCoordinator.sync();
  },input);
  await expect.poll(()=>page.evaluate(()=>multiIds.every(id=>widget.activeChart()._chartWidget.model().model().dataSourceForId(id).data().size()>100))).toBe(true);
  const multi=await page.evaluate(()=>multiIds.map(id=>{const study=widget.activeChart()._chartWidget.model().model().dataSourceForId(id);return {size:study.data().size(),last:study.data().last().value};}));
  assert.equal(multi[0].last.length,5);assert.equal(multi[1].last.length,10);
  assert.deepEqual(await page.evaluate(()=>multiErrors),[]);assert.equal(await page.evaluate(()=>multiReads),1);
  const stValues=Object.fromEntries(input.supertrend.series.map(series=>[series.key,series.values.at(-1)?.value]));
  assert.deepEqual(multi[1].last.slice(1),[stValues.up,stValues.down,stValues.fill_reference,stValues.up,stValues.down,stValues.buy_price,stValues.sell_price,stValues.buy_price,stValues.sell_price]);
  assert.ok(Math.abs(multi[2].last[1]-input.lwma7.series[0].values.at(-1).value)<1e-10);
  await page.evaluate(()=>multiCoordinator.dispose());

  assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>probe.log.filter(e=>e.kind==='request').every(e=>!String(e.value.symbol||'').startsWith('MWPY_'))));
  await page.goto(origin+'/product?parent='+encodeURIComponent(origin)+'&initialCount=1000');
  await page.waitForFunction(()=>ready&&widget.activeChart().dataReady());
  await page.evaluate(async input=>{
    managedSessions.set('TEST|1D',{start:input.bars[0].start,revision:1});
    rememberIndicatorBinding('TEST','1D',{bars:input.bars,origin:input.bars[0].start});
    window.productReads=0;
    query=async(ticker,res,args)=>{productReads++;return {bars:input.bars,origin:input.bars[0].start,history_revision:'1',has_more:false,
      indicators:args.indicators.map(spec=>({LWMA:input.result,SWING_SR_V1:input.swing,SUPERTREND_PINE_V1:input.supertrend}[spec.name]))};};
    startIndicatorCoordinator(input.catalog);
    window.productId=await widget.activeChart().createStudy('守望 Python LWMA',false,false);
  },input);
  await expect.poll(()=>page.evaluate(()=>widget.activeChart()._chartWidget.model().model().dataSourceForId(productId).data().size())).toBeGreaterThan(100);
  assert.ok(await page.evaluate(()=>productReads>0));
  // Native parameter restart, five panes, saved layout and template recovery.
  await page.evaluate(()=>widget.activeChart().getStudyById(productId).setInputValues([{id:'period',value:7}]));
  await page.evaluate(input=>{
    query=async(ticker,res,args)=>{productReads++;return {bars:input.bars,origin:input.bars[0].start,history_revision:'1',has_more:false,
      indicators:args.indicators.map(spec=>spec.name==='LWMA'?(spec.params.period===7?input.lwma7:input.result):spec.name==='SWING_SR_V1'?input.swing:input.supertrend)};};
  },input);
  await expect.poll(()=>page.evaluate(()=>widget.activeChart()._chartWidget.model().model().dataSourceForId(productId).data().last()?.value[1])).toBe(input.lwma7.series[0].values.at(-1).value);
  await page.evaluate(()=>widget.setLayout('5h'));
  await page.waitForFunction(()=>widget.chartsCount()===5 && Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean));
  await page.evaluate(async()=>{
    window.fiveIds=[];
    for(let i=0;i<5;i++) {
      const chart=widget.chart(i);
      for(const study of chart.getAllStudies())chart.removeEntity(study.id);
      fiveIds.push(await chart.createStudy('守望 Python LWMA',false,false));
    }
    await indicatorCoordinator.sync();
  });
  await expect.poll(()=>page.evaluate(()=>fiveIds.every((id,i)=>widget.chart(i)._chartWidget.model().model().dataSourceForId(id).data().size()>20))).toBe(true);
  await page.evaluate(()=>{window.layoutSaved=null;return new Promise(resolve=>widget.save(value=>{layoutSaved=value;resolve();}));});
  await page.evaluate(()=>{indicatorCoordinator.dispose();widget.load(layoutSaved);});
  await page.waitForFunction(()=>widget.chartsCount()===5 && Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean));
  await page.evaluate(catalog=>startIndicatorCoordinator(catalog),input.catalog);
  await expect.poll(()=>page.evaluate(()=>Array.from({length:5},(_,i)=>widget.chart(i)).every(chart=>chart.getAllStudies().some(study=>chart._chartWidget.model().model().dataSourceForId(study.id).data().size()>20)))).toBe(true);
  const diagnostic=await page.evaluate(()=>indicatorCoordinator.diagnostics());assert.equal(diagnostic.consumers,5);
  await page.evaluate(()=>indicatorCoordinator.dispose());
  console.log('PASS Python LWMA/Swing/SuperTrend: native result consumer, zero/negative/null, correction, revision fences, shortened/empty snapshots and detach',JSON.stringify({accepted,before}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
