// Task synthetic supply; real API/PostgreSQL/fixed artifacts and native cache.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',supply:'task synthetic; real fixed artifacts',cases:[],reads:[]};
 const jobs=[];
 p.page.on('response',x=>{if(x.url().endsWith('/api/charts/data'))jobs.push((async()=>{const b=await x.json();r.reads.push({at:Date.now(),query:x.request().postDataJSON(),status:x.status(),count:b.bars?.length,has_more:b.has_more,revision:b.revision_id,input_revision:b.input_revision,pending:b.pending});})());});
 const state=()=>p.host.evaluate(()=>{const c=widget.activeChart(),ts=c.getTimeScale(),m=c._chartWidget.model().model(),bars=m.mainSeries().bars();return {symbol:c.symbol(),resolution:c.resolution(),range:c.getVisibleRange(),ready:c.dataReady(),spacing:ts.barSpacing(),offset:ts.rightOffset(),first:bars.firstIndex(),last:bars.lastIndex(),requesting:m.timeScale()._requestingMoreData,diag:MWNativeReserve.diagnostics(),accepted:MWNativeReserve.acceptedRanges()};});
 const settle=()=>p.host.waitForFunction(()=>{const m=widget.activeChart()._chartWidget.model().model();return widget.activeChart().dataReady()&&!m._lastGotoTimeRange&&!m.timeScale()._requestingMoreData&&!rangeGuard.busy()&&!edgeGuard.busy()&&!MWNativeNavigation.busy()&&!pending.size&&!requests.length&&MWNativeReserve.diagnostics().flights===0;},null,{timeout:60000});
 try {
  await p.host.evaluate(()=>{widget.activeChart().removeAllStudies();widget.setLayout('s');});await p.host.waitForFunction(()=>widget.chartsCount()===1);
  for(const symbol of ['MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c','MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a','MWP:EURUSD']) {
    await p.host.evaluate(s=>widget.activeChart().setSymbol(s,{doNotActivateChart:true}),symbol);await settle();
    for(const resolution of ['1','5','60','1D']) {
      await p.host.evaluate(res=>widget.activeChart().setResolution(res,{doNotActivateChart:true}),resolution);await p.page.waitForTimeout(250);await settle();
      await p.host.evaluate(()=>widget.activeChart().getTimeScale().setBarSpacing(6));
      await p.host.waitForFunction(()=>{const c=widget.activeChart(),d=MWNativeReserve.diagnostics(),m=d.models.find(m=>m.symbol===c.symbol()&&m.resolution===c.resolution()),key=MWSeries.encode(decode(c.symbol()).symbol,decode(c.symbol()).series_kind)+'|'+c.resolution()+'|';return m?.geometry&&(m.geometry.reserve>=m.geometry.screen*2-2||d.threads.some(t=>t.key===key&&t.endOfData));},null,{timeout:60000});await settle();
      const before=await state();assert.ok(before.range.to>before.range.from);const model=before.diag.models.find(m=>m.resolution===resolution&&m.symbol.toLowerCase()===symbol.toLowerCase());assert.ok(model?.geometry);
      assert.ok(model.geometry.reserve>=model.geometry.screen*2-2||before.diag.threads.some(t=>t.key.toLowerCase().startsWith((symbol+'|'+resolution+'|').toLowerCase())&&t.endOfData),'two-screen reserve or confirmed fixed origin');
      const start=r.reads.length;
      // A small warm-cache pan must keep the native column width and current
      // series. Native may asynchronously refill reserve behind the viewport.
      await p.host.evaluate(()=>{const ts=widget.activeChart().getTimeScale();ts.setRightOffset(ts.rightOffset()-10);});await p.page.waitForTimeout(100);const warm=await state();
      assert.equal(warm.spacing,before.spacing);assert.equal(warm.symbol,before.symbol);assert.ok(warm.range.to>warm.range.from);
      assert.equal(warm.ready,true);assert.equal(warm.requesting,false,'warm cached pan does not wait for network');
      // Slow and fast pointer drags, then reversal; measure actual native cache.
      const pane=await p.host.evaluate(()=>{const n=widget.activeChart()._chartWidget.paneWidgets().find(p=>p.containsMainSeries()).canvasElement().getBoundingClientRect();return {x:n.x,y:n.y,width:n.width,height:n.height};});
      const frame=await(await p.ui.frameElement()).boundingBox();
      for(const [reverse,steps,delay] of [[false,12,20],[false,4,5],[true,8,15]]) {
        const x=frame.x+pane.x+pane.width*(reverse?.7:.3),y=frame.y+pane.y+pane.height*.4;
        await p.page.mouse.move(x,y);await p.page.mouse.down();for(let i=1;i<=steps;i++){await p.page.mouse.move(x+(reverse?-1:1)*pane.width*.25*i/steps,y);await p.page.waitForTimeout(delay);}await p.page.mouse.up();
      }
      await settle();const after=await state();assert.equal(after.spacing,before.spacing);assert.equal(after.symbol,before.symbol);assert.equal(after.resolution,resolution);
      r.cases.push({name:'cold/warm reserve slow/fast/reverse pointer and viewport stability',symbol,resolution,before,warm,after,backgroundReads:r.reads.length-start});console.log('PASS',symbol,resolution);
    }
  }
  // Actual native range demand exceeds the former 20k bridge rejection.
  await p.host.evaluate(()=>{globalThis.reserveAcceptanceLoads=[];const original=feed.getBars;feed.getBars=function(s,res,p,cb,err){const entry={ticker:s.ticker,res,countBack:p.countBack};reserveAcceptanceLoads.push(entry);return original(s,res,p,(bars,meta)=>{entry.rows=bars.length;entry.meta=meta;return cb(bars,meta);},e=>{entry.error=String(e);return err(e);});};widget.activeChart().setSymbol('MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c');if(widget.activeChart().resolution()!=='1')widget.activeChart().setResolution('1');});await settle();
  await p.host.evaluate(async()=>{const c=widget.activeChart(),end=c.getVisibleRange().to;await c.setVisibleRange({from:end-35000*60,to:end},{rejectByTimeout:120000});});await settle();
  const large=await p.host.evaluate(()=>reserveAcceptanceLoads);r.largeDemand=large;assert.ok(large.some(x=>x.countBack>20000&&x.rows>20000),'actual native >20k demand completes atomically');
  r.cases.push({name:'real native range load above 20000 bars',loads:large,state:await state()});
  await Promise.all(jobs);assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;r.last=await state().catch(()=>null);throw e;}finally{await Promise.allSettled(jobs);r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-reserve.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
