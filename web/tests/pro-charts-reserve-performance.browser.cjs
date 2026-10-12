// Complement the pointer-drag matrix with measured idle/native cached-pan frames.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
const output=process.env.MW_RESERVE_PERFORMANCE_OUTPUT||'docs/verification/pro-charts-20261011/browser-reserve-performance.json';
const quantile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil((sorted.length-1)*p)];};
const summarize=values=>({count:values.length,median:quantile(values,.5),p95:quantile(values,.95),maximum:Math.max(...values)});
(async()=>{
 const p=await product(),report={environment:'Ubuntu quant-server / mw-pro-charts-20261011',scope:'Real native cache and frame timings; task synthetic supply. Headless Chromium timings describe this host, not physical-device or production frame rates.',method:'30 idle and 60 cached-pan requestAnimationFrame samples per series/timeframe; one bar per frame then reverse, using the native time-scale API. Actual pointer-drag behavior is covered separately in browser-reserve.json.',cases:[],errors:[]};
 let delayed=false;const reads=[];
 await p.page.route(/\/api\/charts\/(data|reserve)(?:\?|$)/,async route=>{
  if(delayed){const at=Date.now();reads.push({path:new URL(route.request().url()).pathname,startedAt:at,injectedDelayMilliseconds:900});await new Promise(ok=>setTimeout(ok,900));}
  try{return await route.continue();}catch{return;}
 });
 const settle=()=>p.host.waitForFunction(()=>!loading&&!pending.size&&!requests.length&&!rangeGuard.busy()&&!edgeGuard.busy()&&!MWNativeNavigation.busy()&&widget.activeChart().dataReady()&&MWNativeReserve.diagnostics().flights===0,null,{timeout:90000});
 try {
  await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('s');widget.activeChart().removeAllStudies();});
  await p.host.waitForFunction(()=>widget.chartsCount()===1);
  for(const symbol of ['MWP:EURUSD','MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c','MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a']) {
   if(process.env.MW_RESERVE_PERFORMANCE_SYMBOL&&process.env.MW_RESERVE_PERFORMANCE_SYMBOL!==symbol)continue;
   if((await p.host.evaluate(()=>widget.activeChart().symbol())).toLowerCase()!==symbol.toLowerCase()) {
    await p.host.evaluate(s=>widget.activeChart().setSymbol(s,{doNotActivateChart:true}),symbol);
   }
   await settle();
   for(const resolution of ['1','5','60','1D']) {
    if(process.env.MW_RESERVE_PERFORMANCE_RESOLUTION&&process.env.MW_RESERVE_PERFORMANCE_RESOLUTION!==resolution)continue;
    const began=Date.now();
    if(await p.host.evaluate(()=>widget.activeChart().resolution())!==resolution) {
     await p.host.evaluate(r=>widget.activeChart().setResolution(r,{doNotActivateChart:true}),resolution);
    }
    await settle();await p.host.evaluate(()=>widget.activeChart().getTimeScale().setBarSpacing(6));
    await p.host.waitForFunction(()=>{
     const c=widget.activeChart(),d=MWNativeReserve.diagnostics(),m=d.models.find(m=>m.symbol===c.symbol()&&m.resolution===c.resolution());
     const key=MWSeries.encode(decode(c.symbol()).symbol,decode(c.symbol()).series_kind)+'|'+c.resolution()+'|';
     return m?.geometry&&(m.geometry.reserve>=m.geometry.screen*2-2||d.threads.some(t=>t.key===key&&t.endOfData));
    },null,{timeout:90000});await settle();
    const reserveReadyMilliseconds=Date.now()-began;
    const readStart=reads.length;delayed=true;
    const measured=await p.host.evaluate(async()=>{
     const c=widget.activeChart(),scale=c.getTimeScale(),model=c._chartWidget.model().model();
     const before={symbol:c.symbol(),resolution:c.resolution(),offset:scale.rightOffset(),spacing:scale.barSpacing(),range:c.getVisibleRange(),reserve:MWNativeReserve.diagnostics()};
     const key=MWSeries.encode(decode(c.symbol()).symbol,decode(c.symbol()).series_kind)+'|'+c.resolution()+'|';
     before.confirmedOrigin=before.reserve.threads.some(t=>t.key===key&&t.endOfData);
     const frames=async(count,pan)=>{
      const intervals=[],calls=[],samples=[];let previous=await new Promise(requestAnimationFrame);
      for(let i=0;i<count;i++) {
       const time=await new Promise(requestAnimationFrame);intervals.push(time-previous);previous=time;
       const started=performance.now();
       const expected=before.offset+(i<count/2?-(i+1):-(count-i-1));
       if(pan)scale.setRightOffset(expected);
       const offset=scale.rightOffset(),range=c.getVisibleRange();calls.push(performance.now()-started);
       const visible=model.timeScale().visibleBarsStrictRange(),points=model.timeScale().points().range().value();
       samples.push({expectedOffset:pan?expected:before.offset,actualOffset:offset,spacing:scale.barSpacing(),range,visibleIndices:[visible.firstBar(),visible.lastBar()],loadedIndices:[points.firstIndex,points.lastIndex],requesting:model.timeScale()._requestingMoreData,ready:c.dataReady()});
      }
      return {intervals,calls,samples};
     };
     const idle=await frames(30,false),pan=await frames(60,true);
     return {before,idle,pan,after:{symbol:c.symbol(),resolution:c.resolution(),offset:scale.rightOffset(),spacing:scale.barSpacing(),range:c.getVisibleRange(),reserve:MWNativeReserve.diagnostics()}};
    });
    delayed=false;const backgroundReads=reads.slice(readStart);
    const idleFrames=summarize(measured.idle.intervals),panFrames=summarize(measured.pan.intervals),panCalls=summarize(measured.pan.calls);
    // Budget derives from each case's measured idle baseline: three median
    // refresh intervals or twice its p95; synchronous work gets half a frame.
    const frameBudget=Math.max(idleFrames.median*3,idleFrames.p95*2);
    const synchronousBudget=Math.max(8,idleFrames.median/2);
    report.lastMeasurement={symbol,resolution,measured};
    assert.ok(panFrames.p95<=frameBudget,`${symbol}/${resolution} cached-pan frame p95 exceeds idle-derived budget`);
    assert.ok(panCalls.p95<=synchronousBudget,`${symbol}/${resolution} native pan call p95 exceeds half-frame budget`);
    assert.equal(measured.before.symbol,measured.after.symbol);assert.equal(measured.after.resolution,resolution);
    assert.equal(measured.after.spacing,measured.before.spacing);assert.ok(Math.abs(measured.after.offset-measured.before.offset)<1e-6);
    assert.ok(measured.pan.samples.every(s=>Math.abs(s.actualOffset-s.expectedOffset)<1e-6&&s.spacing===6&&s.range.to>s.range.from&&s.ready&&(s.visibleIndices[0]>=s.loadedIndices[0]||(measured.before.confirmedOrigin&&s.range.from===measured.before.range.from&&!s.requesting))),'every cached pan stays in loaded points or at the confirmed fixed origin, and changes offset synchronously');
    report.cases.push({name:'idle baseline and native cached-pan frames/response',symbol,resolution,coverage:measured.before.confirmedOrigin?'confirmed fixed origin; history may be shorter than one screen':'loaded native reserve',reserveReadyMilliseconds,idleFramesMilliseconds:idleFrames,panFramesMilliseconds:panFrames,panCallMilliseconds:panCalls,frameBudgetMilliseconds:frameBudget,synchronousBudgetMilliseconds:synchronousBudget,backgroundReads,backgroundRequestFlagFrames:measured.pan.samples.filter(s=>s.requesting).length,measured,passed:true});
    delete report.lastMeasurement;
    console.log(JSON.stringify({symbol,resolution,frameP95:panFrames.p95,callP95:panCalls.p95,passed:true}));
   }
  }
  if(!process.env.MW_RESERVE_PERFORMANCE_SYMBOL)assert.ok(reads.length>0,'controlled delayed background read was exercised');
  await p.page.unrouteAll({behavior:'wait'});assert.deepEqual(p.errors,[]);report.passed=true;
 }catch(e){report.failure=e.stack;throw e;}
 finally {report.errors=p.errors;fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
