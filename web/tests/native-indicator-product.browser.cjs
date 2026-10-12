// Compiled host, actual bridge/datafeed and pinned native engine. Python fixture
// responses are supplied by parent RPC; this is not Docker/backend acceptance.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),assets=process.env.MW_PENDING_HOST_ASSETS;
assert.ok(assets,'Set MW_PENDING_HOST_ASSETS to this task privately compiled host');
const fixture=JSON.parse(execFileSync(path.join(root,'.venv/bin/python'),['-c',`
import json,math
from alerts.chart_indicators import public_catalog,calculate
end=1790640000000; pages={}; variants=[]
for frame,step in [('D1',86400000),('M5',300000)]:
 rows=[]
 for i in range(1000):
  t=end-(1000-i)*step; value=100+math.sin(i/3)*4
  rows.append(dict(start=t,end=t+step,chart_time=t,open=value,high=value+2,low=value-2,close=value+1,complete=True,revision=1))
 specs=[dict(name='LWMA',params={'period':p}) for p in [5,7,20]]+[dict(name='SWING_SR_V1'),dict(name='SUPERTREND_PINE_V1')]
 pages[frame]=dict(bars=rows,results=[calculate(rows,spec) for spec in specs])
 if frame=='M5':
  tail=dict(rows[-1],start=end,end=end+step,chart_time=end,close=110,high=112,low=100,open=105,revision=2)
  appended=[*rows,tail]
  corrected=[*appended[:-1],dict(tail,close=120,high=125,revision=3)]
  for variant in [appended,corrected,corrected[:-2]]:
   variants.append(dict(bars=variant,results=[calculate(variant,spec) for spec in specs]))
print(json.dumps(dict(catalog={k:public_catalog()[k] for k in ['LWMA','SWING_SR_V1','SUPERTREND_PINE_V1']},pages=pages,variants=variants)))
`],{maxBuffer:8*1024*1024,cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')}}));
const origin='https://mw-product-indicators.invalid',errors=[],requests=[],states=[],messages=[];
let row={id:'pending-indicator-fixture',name:'Pending indicator fixture',revision:0,
 document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',series_kind:'provider',interval:'1D'}};
const preferences=[];let fixtureRevision=1,indicatorGate,releaseIndicators;
async function rpc(message){messages.push({type:message.type,op:message.query?.op,query:message.query?.op?undefined:message.query});
 if(message.type==='error')errors.push(message.error);
 if(message.type==='chart-indicator-state')states.push(message);
 if(message.type==='loaded')return {type:'init',document:row.document,workspace:row,catalog:fixture.catalog,preferences,
  history_capabilities:{protocol:1,mode:'continuous',max_bars:200000,workspace_bars:4000000,response_bytes:134217728}};
 if(message.id==null)return;
 const q=message.query,args=q?.args || {};let result={};
 if(message.type==='workspace'){
  if(q.op==='list')result=[{...row,symbol:row.document.symbol,resolution:row.document.interval}];
  if(q.op==='load')result={...row,content:JSON.stringify(row.document.state)};
  if(q.op==='save'){
   row={...row,name:args.name,revision:row.revision+1,document:{...row.document,state:JSON.parse(args.content),symbol:args.symbol,interval:args.resolution}};
   result={...row,symbol:args.symbol,resolution:args.resolution};
  }
 }else if(message.type==='chart-alert-ui-rpc'){
  result=[];
 }else if(message.type==='preferences' && q.op==='save'){
  result={...args,id:String(preferences.length+1),revision:args.revision+1};preferences.push(result);
 }else if(q?.op==='resolve')result={source:'binance',calendar:'utc0',precision:2,basis:'last',volume_kind:'unavailable'};
 else if(['quotes','search','list','alerts'].includes(q?.op) || message.type==='watchlist')result=[];
 else if(q?.op==='viewport')result={closed:false};
 else if(q?.op==='serverTime')result=1790640000;
 else if(message.type==='data'){
  if(q.indicators?.length && indicatorGate)await indicatorGate;
  requests.push({kind:'data',frame:q.timeframe,indicators:q.indicators?.map(s=>s.name),before:q.before,limit:q.limit,at:performance.now()});
  const data=fixture.pages[q.timeframe];assert.ok(data,'unsupported fixture timeframe '+q.timeframe);
  const eligible=data.bars.filter(b=>b.start<(q.before || Infinity)),bars=eligible.slice(-q.limit);
  const specs=q.indicators || [];
  const results=specs.map(spec=>{
   const result=data.results.find(r=>r.name===spec.name && Object.entries(spec.params || {}).every(([k,v])=>r.params[k]===v));
   assert.ok(result,'unsupported parameters '+JSON.stringify(spec));
   return {...result,series:result.series.map(s=>({...s,values:s.values.filter(v=>bars.some(b=>b.start===v.time))}))};
  });
  result={bars,indicators:results,has_more:eligible.length>bars.length,cache_revision:fixtureRevision,as_of:1790640000000+fixtureRevision*300000,
   calculation_origin:specs.length?data.bars[0].start:undefined,history_dependency_first:data.bars[0].start,
   next_before:bars[0]?.start,reserve_status:q.native_reserve?'ready':undefined,history_pages:1};
 }
 return {type:'result',id:message.id,result};
}
(async()=>{
 const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 page.on('pageerror',e=>errors.push(e.stack));await page.clock.setFixedTime(new Date('2026-09-29T00:00:00Z'));
 await page.exposeFunction('fixtureMessage',rpc);
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.fulfill({status:204,body:''});
  if(url.pathname==='/parent')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><body style="margin:0"><iframe style="width:100vw;height:100vh;border:0" src="/?parent=${encodeURIComponent(origin)}"></iframe><script>addEventListener('message',async e=>{if(e.data?.channel!=='mw-chart-v1')return;const value=await fixtureMessage(e.data);if(value)e.source.postMessage({channel:'mw-chart-v1',...value},location.origin);});</script>`});
  const file=path.resolve(assets,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  assert.ok(file.startsWith(path.resolve(assets)+path.sep));if(!fs.existsSync(file))return route.fulfill({status:404});
  const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
  return route.fulfill({contentType:mime[path.extname(file)] || 'application/octet-stream',body:fs.readFileSync(file)});
 });
 try{
  await page.goto(origin+'/parent');const host=page.frames().find(f=>f.url().includes('/?parent='));assert.ok(host);
  await host.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:30000});
  await host.evaluate(async()=>{
   window.ids=[];
   for(const name of ['LWMA','SWING_SR_V1','SUPERTREND_PINE_V1'])ids.push(await widget.activeChart().createStudy('守望 Python '+name,false,false));
  });
  const data=()=>host.evaluate(()=>ids.map(id=>{const chart=widget.activeChart(),study=chart._chartWidget.model().model().dataSourceForId(id);return {size:study.data().size(),last:study.data().last()?.value};}));
  await expect.poll(async()=>(await data()).every(d=>d.size>100)).toBe(true);
  assert.equal((await data())[0].last[1],fixture.pages.D1.results[0].series[0].values.at(-1).value);
  assert.ok(requests.some(r=>r.indicators?.length===3),'three distinct indicators are batched in one page');
  assert.ok(!requests.some(r=>r.indicators?.length && r.kind==='MWPY_'));
  await host.evaluate(()=>widget.activeChart().getStudyById(ids[0]).setVisible(false));
  await expect.poll(()=>host.evaluate(()=>indicatorCoordinator.diagnostics().consumers)).toBe(2);
  await host.evaluate(()=>widget.activeChart().getStudyById(ids[0]).setVisible(true));
  await expect.poll(()=>host.evaluate(()=>indicatorCoordinator.diagnostics().consumers)).toBe(3);
  await expect.poll(async()=>(await data())[0].last?.[1]).toBe(fixture.pages.D1.results[0].series[0].values.at(-1).value);
  await host.evaluate(()=>widget.activeChart().getStudyById(ids[2]).setInputValues([{id:'showsignals',value:false},{id:'highlighting',value:false}]));
  await expect.poll(async()=>(await data())[2].last?.slice(4,6)).toEqual([null,null]);
  await expect.poll(async()=>(await data())[2].last?.slice(8,10)).toEqual([null,null]);
  await host.evaluate(()=>widget.activeChart().getStudyById(ids[0]).setInputValues([{id:'period',value:7}]));
  await expect.poll(async()=>(await data())[0].last?.[1]).toBe(fixture.pages.D1.results[1].series[0].values.at(-1).value);
  await host.evaluate(()=>widget.activeChart().setResolution('5'));
  await expect.poll(async()=>(await data()).every(d=>d.size>100)).toBe(true);
  await expect.poll(async()=>(await data())[0].last?.[0]).toBe(fixture.pages.M5.bars.at(-1).start/1000);
  // Exercise ordinary tail delivery and correction/reset through the compiled
  // product's real market-event boundary, with Python-computed fixture results.
  async function marketEvent(type,bars){
    const event=await host.evaluate(({type,bars,revision})=>{
      const sub=[...subscriptions.values()].find(s=>s.symbol==='MWP:BTCUSDT'&&s.res==='5'&&!s.marketPaused);
      if(!sub)throw Error('missing active main-chart market listener');
      return {type,bars,listener:sub.marketListener,generation:sub.marketGeneration,sequence:sub.marketSequence+1,
        cache_revision:revision,as_of:1790640000000+revision*300000};
    },{type,bars,revision:fixtureRevision});
    await page.evaluate(event=>document.querySelector('iframe').contentWindow.postMessage({channel:'mw-chart-v1',type:'market-event',event},location.origin),event);
  }
  await host.evaluate(()=>{
    window.tailResets=0;window.tailEmptyFrames=0;window.watchTail=true;
    const chart=widget.activeChart(),reset=chart.resetData.bind(chart);
    window.restoreTailReset=()=>chart.resetData=reset;
    chart.resetData=(...args)=>{tailResets++;return reset(...args);};
    const watch=()=>{if(!watchTail)return;if(ids.some(id=>chart._chartWidget.model().model().dataSourceForId(id).data().size()===0))tailEmptyFrames++;requestAnimationFrame(watch);};
    requestAnimationFrame(watch);
  });
  fixture.pages.M5=fixture.variants[0];fixtureRevision++;
  indicatorGate=new Promise(resolve=>releaseIndicators=resolve);
  await marketEvent('bars',[fixture.pages.M5.bars.at(-1)]);
  await expect.poll(()=>host.evaluate(()=>widget.activeChart()._chartWidget.model().model().mainSeries().data().last()?.value[0])).toBe(fixture.pages.M5.bars.at(-1).start/1000);
  assert.ok((await data()).every(d=>d.size>100),'tail preparation retains the previous valid interval');
  releaseIndicators();indicatorGate=null;
  await expect.poll(async()=>(await data())[0].last?.[1]).toBe(fixture.pages.M5.results[1].series[0].values.at(-1).value);
  await host.evaluate(()=>{watchTail=false;restoreTailReset();});
  assert.deepEqual(await host.evaluate(()=>({resets:tailResets,empty:tailEmptyFrames})),{resets:0,empty:0},'ordinary append preserves curves without chart reset');
  fixture.pages.M5=fixture.variants[1];fixtureRevision++;
  indicatorGate=new Promise(resolve=>releaseIndicators=resolve);
  await marketEvent('reset',[]);
  await expect.poll(async()=>(await data()).every(d=>d.size===0)).toBe(true);
  releaseIndicators();indicatorGate=null;
  await expect.poll(async()=>(await data())[0].last?.[1]).toBe(fixture.pages.M5.results[1].series[0].values.at(-1).value);
  fixture.pages.M5=fixture.variants[2];fixtureRevision++;
  await marketEvent('reset',[]);
  await expect.poll(async()=>(await data())[0].last?.[0]).toBe(fixture.pages.M5.bars.at(-1).start/1000);
  await expect.poll(async()=>(await data())[0].last?.[1]).toBe(fixture.pages.M5.results[1].series[0].values.at(-1).value);
  const leftReadStart=requests.length;
  const before=await data();await host.evaluate(()=>widget.activeChart().setVisibleRange({from:1790640000-700*300,to:1790640000-400*300}));
  await expect.poll(async()=>(await data()).every(d=>d.size>=before[0].size)).toBe(true);
  assert.ok(requests.slice(leftReadStart).filter(r=>r.indicators?.length).every(r=>r.before<=before[0].last[0]*1000),'left history reads do not reload the accepted tail');
  await host.evaluate(async()=>{
    const chart=widget.activeChart(),template=chart.createStudyTemplate({saveSymbol:false,saveInterval:false});
    for(const study of chart.getAllStudies())chart.removeEntity(study.id);
    await indicatorCoordinator.sync();chart.applyStudyTemplate(template);
  });
  await expect.poll(()=>host.evaluate(()=>{
    const chart=widget.activeChart();return chart.getAllStudies().length===3 && chart.getAllStudies().every(s=>chart._chartWidget.model().model().dataSourceForId(s.id).data().size()>100);
  })).toBe(true);
  const templateValues=await host.evaluate(()=>widget.activeChart().getAllStudies().map(s=>({name:s.name,inputs:widget.activeChart().getStudyById(s.id).getInputValues()})));
  assert.ok(templateValues.some(s=>s.inputs.some(i=>i.id==='period' && i.value===7)),'study template preserves saved LWMA parameters');
  assert.ok(templateValues.some(s=>s.inputs.some(i=>i.id==='showsignals' && i.value===false)),'study template preserves display choices');
  if(process.env.MW_PENDING_PERFORMANCE==='true') {
    const measurements=[];
    for(const lane of ['native','old-python','new-python'])for(const count of [1,4,8]) {
      const readsBefore=requests.filter(r=>r.indicators?.length).length;
      const sample=await host.evaluate(async({lane,count,catalog})=>{
        const chart=widget.activeChart();
        for(const study of chart.getAllStudies())chart.removeEntity(study.id);
        await indicatorCoordinator.sync();
        MWNativeIndicatorResults.configure(catalog,{enable:lane!=='old-python'});
        const ids=[],started=performance.now();let first;
        for(let i=0;i<count;i++)ids.push(await chart.createStudy(lane==='native'?'Moving Average Weighted':'守望 Python LWMA',false,false,lane==='native'?{length:5}:{period:5}));
        const sources=()=>ids.map(id=>chart._chartWidget.model().model().dataSourceForId(id));
        const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        while(!sources().every(study=>study.data().size()>100)) {
          if(first===undefined && sources().some(study=>study.data().size()>0))first=performance.now()-started;
          if(performance.now()-started>15000)throw Error('performance study preparation timeout');
          await frame();
        }
        first ??= performance.now()-started;
        const complete=performance.now()-started,steps=[];let blankFrames=0,resets=0;
        const original=chart.resetData.bind(chart);chart.resetData=(...args)=>{resets++;return original(...args);};
        let watching=true;
        const watch=()=>{if(!watching)return;if(sources().some(study=>study.data().size()===0))blankFrames++;requestAnimationFrame(watch);};requestAnimationFrame(watch);
        try {
          for(let i=0;i<12;i++){
            const step=performance.now();chart.getTimeScale().setRightOffset(i%2?-70:-35);await frame();steps.push(performance.now()-step);
          }
        }finally{watching=false;chart.resetData=original;}
        const sorted=steps.sort((a,b)=>a-b);
        return {lane,count,firstValidDataMs:first,allValidDataMs:complete,cachedNavigationP50Ms:sorted[Math.floor(sorted.length*.5)],
          cachedNavigationP95Ms:sorted[Math.floor(sorted.length*.95)],emptyDataFrames:blankFrames,chartResets:resets,
          heapBytes:performance.memory?.usedJSHeapSize ?? null};
      },{lane,count,catalog:fixture.catalog});
      sample.indicatorReads=requests.filter(r=>r.indicators?.length).length-readsBefore;
      assert.equal(sample.chartResets,0);assert.equal(sample.emptyDataFrames,0);
      measurements.push(sample);
    }
    await host.evaluate(catalog=>{
      for(const study of widget.activeChart().getAllStudies())widget.activeChart().removeEntity(study.id);
      MWNativeIndicatorResults.configure(catalog,{enable:true});
    },fixture.catalog);
    const evidence={environment:'Ubuntu Chromium, compiled product host; same controlled Python/source data and in-memory RPC responses',
      limitations:['valid data availability, not pixel draw timestamp','two animation frames per cached-navigation sample','no real network, database or backend CPU measurement','heap is whole-frame/browser estimate','not Docker/full-stage-D acceptance'],measurements};
    fs.writeFileSync(process.env.MW_PENDING_PERFORMANCE_EVIDENCE || '/tmp/mw-pending-indicator-performance.json',JSON.stringify(evidence,null,2));
    console.log('PERFORMANCE',JSON.stringify(evidence));
  }
  await host.evaluate(()=>{MWSyncCoordinator.configure({date:false,time:false,barWidth:false});widget.setLayout('5h');});await host.waitForFunction(()=>widget.chartsCount()===5 && Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean));
  await host.evaluate(async()=>{window.five=[];for(let i=0;i<5;i++)five.push(await widget.chart(i).createStudy('守望 Python LWMA',false,false));});
  await expect.poll(()=>host.evaluate(()=>five.every((id,i)=>widget.chart(i)._chartWidget.model().model().dataSourceForId(id).data().size()>20))).toBe(true);
  await host.waitForFunction(()=>!MWNativeNavigation.busy()&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:15000});
  await host.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
  await page.reload();const restored=page.frames().find(f=>f.url().includes('/?parent='));
  await restored.waitForFunction(()=>ready&&!loading&&widget.chartsCount()===5&&Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:30000});
  await expect.poll(()=>restored.evaluate(()=>Array.from({length:5},(_,i)=>widget.chart(i)).every(c=>c.getAllStudies().some(s=>c._chartWidget.model().model().dataSourceForId(s.id).data().size()>20)))).toBe(true);
  assert.deepEqual(errors,[]);
  const evidence={environment:'Ubuntu Chromium; routed compiled host, Python fixtures, no Docker/backend deployment',passed:true,
   checks:['actual bridge boot and datafeed','batched multi-output Python reads','hide/show demand release and recovery','SuperTrend display inputs','study template restore','parameter generation','D1/M5 switch','left pagination','ordinary tail append without blank/reset','input correction withdraws before recompute','tail retraction through market reset','five panes','saved workspace reload'],
   requestCount:requests.length,indicatorReadCount:requests.filter(r=>r.indicators?.length).length,stateCounts:Object.fromEntries(['preparing','ready','error','removed'].map(state=>[state,states.filter(s=>s.state===state).length]))};
  fs.writeFileSync(process.env.MW_PENDING_PRODUCT_EVIDENCE || '/tmp/mw-pending-native-product.json',JSON.stringify(evidence,null,2));
  console.log('PASS compiled indicator product',JSON.stringify(evidence));
 }catch(error){console.error('PRODUCT_STATE',JSON.stringify({errors,requestCount:requests.length,stateCount:states.length,messages:messages.map(m=>({type:m.type,op:m.op})),frames:page.frames().map(f=>f.url()),body:await page.locator('body').innerText(),host:await page.frames().find(f=>f.url().includes('/?parent='))?.evaluate(()=>({ready:typeof ready==='undefined'?null:ready,loading:typeof loading==='undefined'?null:loading,widget:typeof widget==='undefined'?null:!!widget,error:document.getElementById('error')?.textContent,pending:typeof pending==='undefined'?null:[...pending.keys()],queued:typeof requests==='undefined'?null:requests.length})).catch(()=>null)}));throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
