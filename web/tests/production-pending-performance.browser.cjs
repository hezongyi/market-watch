// Real loopback HTTP/PostgreSQL/Python. Valid-data/next-frame timings do not
// prove pixel paint. Backend caches stay intact; never label these cold DB runs.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base='http://127.0.0.1:20271',origin='http://127.0.0.1:20272',out='/tmp/mw-pending-fixes-20261013-private';
const median=values=>values.length?[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]:null;
(async()=>{
 const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox','--enable-precise-memory-info']});
 const measurements=[];
 try {
  for(let repetition=0;repetition<Number(process.env.MW_PENDING_PERFORMANCE_REPETITIONS || 1);repetition++)for(const lane of (process.env.MW_PENDING_PERFORMANCE_LANES || 'native,old-python,new-python').split(','))for(const count of (process.env.MW_PENDING_PERFORMANCE_COUNTS || '1,4,8').split(',').map(Number)){
   const context=await browser.newContext({viewport:{width:1600,height:1100}}),page=await context.newPage(),network=[],startedRequests=[],settledRequests=new WeakSet(),errors=[],captures=[];
   if(process.env.MW_PENDING_SYNTHETIC_CLOCK)await page.clock.setFixedTime(new Date(Number(process.env.MW_PENDING_SYNTHETIC_CLOCK)));
   page.on('pageerror',e=>errors.push(e.message));
   page.on('requestfailed',request=>settledRequests.add(request));
   page.on('request',request=>{
    const path=new URL(request.url()).pathname;
    if(!/^\/api\/charts\/(data|reserve|history-loads)(?:\/|$)/.test(path))return;
    const body=request.postData()?request.postDataJSON():{},q=body.query || body;
    startedRequests.push({request,indicator:q.indicators?.length || 0});
   });
   const captureFinished=request=>{
    settledRequests.add(request);
    const path=new URL(request.url()).pathname;
    if(!/^\/api\/charts\/(data|reserve|history-loads)(?:\/|$)/.test(path))return;
    captures.push((async()=>{
      const body=request.postData()?request.postDataJSON():{},q=body.query || body,timing=request.timing(),sizes=await request.sizes().catch(()=>({}));
      const response=await request.response(),headers=await response.allHeaders();
      const spans=Object.fromEntries((headers['server-timing'] || '').split(',').map(s=>s.trim().match(/^([a-z_]+);dur=([\d.]+)$/)).filter(Boolean).map(m=>[m[1],Number(m[2])]));
      network.push({kind:path.includes('history-loads')?'history-loads':path.split('/').at(-1),indicator:q.indicators?.length || 0,duration:timing.responseEnd,headers:timing.responseStart,body:timing.responseEnd-timing.responseStart,bytes:sizes.responseBodySize || 0,spans,queries:Number(headers['x-mw-acceptance-queries'] || 0),calculations:Number(headers['x-mw-acceptance-calculations'] || 0),apiPeakRssKiB:Number(headers['x-mw-acceptance-api-peak-rss-kib'] || 0)});
    })().then(()=>null,error=>error));
   };
   page.on('requestfinished',captureFinished);
   await expect.poll(async()=>{try{return (await page.request.get(base+'/readyz')).ok();}catch{return false;}},{timeout:30000}).toBe(true);
   await page.goto(base+'/advanced-charts');
   await page.getByLabel('管理员密码').fill(fs.readFileSync(out+'/password','utf8'));await page.getByRole('button',{name:'登录工作台'}).click();
   await expect.poll(()=>page.frames().some(f=>f.url().startsWith(origin+'/?')),{timeout:30000}).toBe(true);
   const host=page.frames().find(f=>f.url().startsWith(origin+'/?'));
   await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
   await host.evaluate(()=>widget.setLayout('1'));await host.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady());
   await host.evaluate(()=>new Promise(resolve=>widget.activeChart().setSymbol('MWP:BTCUSDT',resolve)));
   await host.evaluate(()=>new Promise(resolve=>widget.activeChart().setResolution('5',resolve)));
   await host.evaluate(async()=>{for(const study of widget.activeChart().getAllStudies())widget.activeChart().removeEntity(study.id);await indicatorCoordinator.sync();});
   if(process.env.MW_PENDING_PERFORMANCE_PREPARE==='true'){
    await host.waitForFunction(()=>!MWNativeNavigation.busy()&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:20000});
    await host.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
    console.log('PASS dedicated synthetic workspace saved without studies');await context.close();return;
   }
   const catalog=await (await page.request.get(base+'/api/advanced-charts/catalog')).json(),startRead=network.length,startRequest=startedRequests.length;
   const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
   const beforeMetrics=await cdp.send('Performance.getMetrics');
   const heapSamples=[],heapReads=[];
   const sampleHeap=()=>{const pending=cdp.send('Performance.getMetrics').then(result=>heapSamples.push(result.metrics.find(m=>m.name==='JSHeapUsedSize')?.value || 0));heapReads.push(pending);};
   sampleHeap();const heapTimer=setInterval(sampleHeap,100);
   let sample;
   try{sample=await host.evaluate(async({lane,count,catalog,pixel,pagination,mixed,pages,sourceBars})=>{
    const chart=widget.activeChart();MWNativeIndicatorResults.configure(catalog,{enable:lane!=='old-python'});
    const ids=[],started=performance.now();let first,firstPixel;
    let checkingPixels=!!pixel;
    const inspectPixels=()=>{
      if(!checkingPixels)return;
      const doc=document.querySelector('iframe')?.contentDocument;
      for(const canvas of doc?.querySelectorAll('canvas') || []){
        if(canvas.getBoundingClientRect().width<200 || canvas.getBoundingClientRect().height<100)continue;
        const context=canvas.getContext('2d');if(!context || !canvas.width || !canvas.height)continue;
        const rgba=context.getImageData(0,0,canvas.width,canvas.height).data;let hits=0;
        for(let i=0;i<rgba.length;i+=4)if(rgba[i]>220&&rgba[i+1]<40&&rgba[i+2]>220&&rgba[i+3]>100&&++hits>=3){firstPixel=performance.now()-started;checkingPixels=false;return;}
      }
      requestAnimationFrame(inspectPixels);
    };
    if(pixel)requestAnimationFrame(inspectPixels);
    for(let i=0;i<count;i++){
      const name=mixed?['LWMA','EMA','SMA','BBANDS','RSI','MACD','ATR','STOCH'][i]:'LWMA';
      const id=await chart.createStudy(lane==='native'?'Moving Average Weighted':'守望 Python '+name,false,false,lane==='native'?{length:5}:name==='LWMA'?{period:5}:undefined);ids.push(id);
      if(pixel){
        const source=chart._chartWidget.model().model().dataSourceForId(id),styles=source.metaInfo().styles;
        chart.getStudyById(id).applyOverrides(Object.fromEntries(Object.values(styles).map(style=>[style.title+'.color','#FF00FF'])));
      }
    }
    const sources=()=>ids.map(id=>chart._chartWidget.model().model().dataSourceForId(id));
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    while(!sources().every(study=>study.data().size()>100)){
     if(first===undefined&&sources().some(study=>study.data().size()>0))first=performance.now()-started;
     if(performance.now()-started>60000)throw Error('indicator preparation timeout');await frame();
    }
    first ??= performance.now()-started;const all=performance.now()-started;
    if(pixel)while(firstPixel===undefined){if(performance.now()-started>60000)throw Error('indicator pixel-paint timeout');await frame();}
    checkingPixels=false;
    await frame();const nextFrame=performance.now()-started;
    let blank=0,resets=0,peakHeap=performance.memory?.usedJSHeapSize || null,watching=true;const blanks=[];
    const watch=()=>{if(!watching)return;if(sources().some(s=>s.data().size()===0)){blank++;if(blanks.length<3)blanks.push({sizes:sources().map(s=>s.data().size()),scopes:ids.map(id=>MWNativeIndicatorResults.scope(chart,id)),diagnostics:indicatorCoordinator.diagnostics()});}peakHeap=Math.max(peakHeap || 0,performance.memory?.usedJSHeapSize || 0)||null;requestAnimationFrame(watch);};requestAnimationFrame(watch);
    const original=chart.resetData.bind(chart);chart.resetData=(...args)=>{resets++;return original(...args);};
    const steps=[];
    try {for(let i=0;i<20;i++){const stamp=performance.now();chart.getTimeScale().setRightOffset(i%2?-80:-35);await frame();steps.push(performance.now()-stamp);}}
    catch(error){watching=false;chart.resetData=original;throw error;}
    const pageSteps=[];let paginationBlank=0;
    const cachedBlank=blank;
    if(pagination)for(let step=0;step<pages;step++){
      const main=chart._chartWidget.model().model().mainSeries().data(),oldSize=main.size(),firstTime=main.first()?.value[0];
      if(!firstTime || oldSize>=sourceBars)break;
      const stamp=performance.now();
      const range=chart.setVisibleRange({from:firstTime-200*300,to:firstTime+100*300});
      Promise.resolve(range).catch(error=>{if(error.code!=='HISTORY_CANCELLED'&&!String(error).includes('已取消旧图表的历史加载'))throw error;});
      while(true){
        const main=chart._chartWidget.model().model().mainSeries().data();
        if(main.size()>oldSize && sources().every(s=>s.data().first()?.value[0]<=main.first().value[0]+5*300)){
          pageSteps.push({ms:performance.now()-stamp,barsBefore:oldSize,barsAfter:main.size()});break;
        }
        if(performance.now()-stamp>15000)throw Error('actual pagination did not extend and align indicator history');
        await frame();
      }
    }
    watching=false;chart.resetData=original;
    paginationBlank=blank-cachedBlank;
    const paged=pageSteps.map(s=>s.ms).sort((a,b)=>a-b);
    const sorted=steps.sort((a,b)=>a-b);
    return {lane,count,indicatorSet:mixed?['LWMA','EMA','SMA','BBANDS','RSI','MACD','ATR','STOCH'].slice(0,count):['LWMA period5 repeated '+count],...(pagination?{paginationSamples:pageSteps,paginationP50Ms:paged.length?paged[Math.floor(paged.length*.5)]:null,paginationP95Ms:paged.length?paged[Math.floor(paged.length*.95)]:null}:{}),...(pixel?{firstIndicatorPixelMs:firstPixel}:{}),firstValidDataMs:first,allValidDataMs:all,nextAnimationFramesMs:nextFrame,cachedNavigationP50Ms:sorted[10],cachedNavigationP95Ms:sorted[19],emptyDataFrames:blank,cachedEmptyDataFrames:cachedBlank,paginationEmptyDataFrames:paginationBlank,chartResets:resets,peakJsHeapBytes:peakHeap,blanks};
   },{lane,count,catalog,pixel:process.env.MW_PENDING_PERFORMANCE_PIXEL==='true',pagination:process.env.MW_PENDING_PERFORMANCE_PAGINATION==='true',mixed:process.env.MW_PENDING_PERFORMANCE_MIXED==='true',pages:Number(process.env.MW_PENDING_PERFORMANCE_PAGES || 5),sourceBars:Number(process.env.MW_PENDING_PERFORMANCE_SOURCE_BARS || 1500)});
   }finally{clearInterval(heapTimer);await Promise.all(heapReads);}
   sample.peakCdpJsHeapBytes=Math.max(...heapSamples);sample.cdpHeapSamples=heapSamples.length;
   const afterMetrics=await cdp.send('Performance.getMetrics'),toMap=value=>Object.fromEntries(value.metrics.map(m=>[m.name,m.value])),before=toMap(beforeMetrics),after=toMap(afterMetrics);
   for(const name of ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'])sample[name+'Seconds']=(after[name] || 0)-(before[name] || 0);
   // Freeze the measurement boundary before draining captures. A late reserve
   // response must not start an unobserved capture while the context closes.
   page.off('requestfinished',captureFinished);
   const captured=await Promise.all(captures);assert.ok(captured.every(item=>item===null),'network capture failed');
   const requests=network.slice(startRead);sample.httpReads=requests.length;sample.indicatorHttpReads=requests.filter(r=>r.indicator).length;sample.httpResponseBytes=requests.reduce((n,r)=>n+r.bytes,0);
   const attempted=startedRequests.slice(startRequest);
   sample.httpRequestsStarted=attempted.length;
   sample.indicatorHttpRequestsStarted=attempted.filter(r=>r.indicator).length;
   sample.httpRequestsFailed=attempted.filter(r=>r.request.failure()).length;
   sample.indicatorHttpRequestsFailed=attempted.filter(r=>r.indicator && r.request.failure()).length;
   sample.httpRequestsUnsettled=attempted.filter(r=>!settledRequests.has(r.request)).length;
   sample.indicatorHttpRequestsUnsettled=attempted.filter(r=>r.indicator && !settledRequests.has(r.request)).length;
   sample.httpKinds=Object.fromEntries([...new Set(requests.map(r=>r.kind))].map(kind=>[kind,requests.filter(r=>r.kind===kind).length]));
   sample.httpDurationMedianMs=median(requests.map(r=>r.duration));sample.httpBodyMedianMs=median(requests.map(r=>r.body));
   sample.repetition=repetition;sample.cacheCondition=process.env.MW_PENDING_PERFORMANCE_RESTARTED==='true'&&repetition===0?'API/PG process restart before browser bootstrap':'resident API/PG, fresh browser';
   const profiled=requests.filter(r=>Object.keys(r.spans).length);
   if(profiled.length){
    sample.profiledHttpReads=profiled.length;
    sample.backendMs=profiled.reduce((n,r)=>n+(r.spans.backend || 0),0);
    sample.sqlDriverMs=profiled.reduce((n,r)=>n+(r.spans.sql || 0),0);
    sample.calculationMs=profiled.reduce((n,r)=>n+(r.spans.calculation || 0),0);
    sample.calculationCpuMs=profiled.reduce((n,r)=>n+(r.spans.calculation_cpu || 0),0);
    sample.sqlQueries=profiled.reduce((n,r)=>n+r.queries,0);
    sample.pythonCalculations=profiled.reduce((n,r)=>n+r.calculations,0);
    sample.apiPeakRssKiB=Math.max(...profiled.map(r=>r.apiPeakRssKiB));
   }
   measurements.push(sample);console.log('MEASURE',JSON.stringify({...sample,blanks:undefined}));
   if(lane!=='old-python'){assert.equal(sample.chartResets,0);assert.equal(sample.emptyDataFrames,0);}
   sample.expectedHistoryCancellations=errors.filter(e=>e==='已取消旧图表的历史加载').length;
   assert.deepEqual(errors.filter(e=>e!=='已取消旧图表的历史加载'),[]);
   await context.close();
  }
  const evidence={environment:'Ubuntu task-owned Docker mw-pending-fixes-20261013, loopback HTTP, actual PostgreSQL/Python, same synthetic M5 source; indicatorSet reported per sample',
   limitations:['fresh browser context per sample; backend cache remains warm/resident','first valid data/next animation frames are not paint timestamps; optional firstIndicatorPixelMs polls actual canvas pixels in large plot canvases after temporary magenta line overrides; scans add CPU/heap overhead, so pixel-run timings and heap are not directly comparable to uninstrumented runs','CDP task/script/layout metrics include the renderer and parent UI','heap samples cover the browser frame, not backend memory','optional acceptance wrapper SQL spans include driver/roundtrip; calculation CPU is thread CPU, backend span excludes final body transfer; sums can overlap concurrent reads','optional pagination timings wait for actual main-history extension and all indicator first times to align; page/sample sizes reported; source size and maximum page count are configurable, only completed extensions contribute','repetitions reported per sample; no claimed performance ratio or full stage-D completion'],measurements};
  fs.writeFileSync(process.env.MW_PENDING_PERFORMANCE_EVIDENCE || out+'/docker-performance.json',JSON.stringify(evidence,null,2));console.log('PASS Docker controlled performance');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
