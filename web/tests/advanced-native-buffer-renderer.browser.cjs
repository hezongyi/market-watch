// Isolated research only. Synthetic data, same-origin public native library; no API/DB.
// LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu node web/tests/advanced-native-buffer-renderer.browser.cjs
const {chromium}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const OUT=process.env.NATIVE_BUFFER_OUTPUT||path.resolve(__dirname,'../../docs/verification/native-history/buffer-renderer');
const ORIGIN=process.env.NATIVE_CHART_ORIGIN||'https://127.0.0.1:15454';
const REP=Number(process.env.NATIVE_BUFFER_REPETITIONS||3);
const SIZES=(process.env.NATIVE_BUFFER_SIZES||'0,400,600,1000,2000,4000,8000,16000').split(',').map(Number);
const EIGHT_SIZES=(process.env.NATIVE_BUFFER_EIGHT_SIZES||'4000,8000,16000').split(',').map(Number);
const CPU_RATE=Number(process.env.NATIVE_BUFFER_CPU_RATE||1);
fs.mkdirSync(OUT,{recursive:true});
function shuffle(a){let seed=20261002;for(let i=a.length-1;i>0;i--){seed=(1664525*seed+1013904223)>>>0;const j=seed%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
function percentile(a,p){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor((s.length-1)*p)];}
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const report={kind:'native v31.1 isolated synthetic M5 rendering benchmark; no API/database traffic',started:new Date().toISOString(),browser:browser.version(),viewport:{width:1400,height:900},method:{syntheticCallbackDelayMs:0,study:'Moving Average length 200 on every chart',ready:'public chart.dataReady + two requestAnimationFrame; rendering proxy, not screenshot proof',heap:'CDP Performance.getMetrics JSHeapUsedSize/TotalSize; post-ready snapshots, not browser RSS or peak',longTasks:'PerformanceObserver in top document and native iframes; tasks >= 50ms',drag:'real mouse drag 600px in 36 steps; top-level RAF intervals; retained-buffer check via feed request count',baseline:'size 0 returns exactly countBack, other sizes max(target,countBack); every public request obeyed',layout:'native widget.setLayout(8); distinct symbols prevent shared-feed deduplication'},samples:[]};
 report.method.cpuThrottlingRate=CPU_RATE;
 const configs=shuffle([...Array(REP)].flatMap((_,repeat)=>SIZES.map(size=>({size,repeat,charts:1}))).concat([...Array(REP)].flatMap((_,repeat)=>EIGHT_SIZES.map(size=>({size,repeat,charts:8})))));
 if(process.env.NATIVE_BUFFER_ONLY_SINGLE==='1')configs.splice(0,configs.length,...configs.filter(c=>c.charts===1));
 const save=()=>fs.writeFileSync(OUT+'/results.json',JSON.stringify(report,null,2));
 try{for(const config of configs){
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:report.viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const client=await page.context().newCDPSession(page);await client.send('Performance.enable');if(CPU_RATE!==1)await client.send('Emulation.setCPUThrottlingRate',{rate:CPU_RATE});
  await page.addInitScript(()=>{globalThis.__tasks=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())__tasks.push({at:performance.timeOrigin+e.startTime,duration:e.duration});}).observe({entryTypes:['longtask']});}catch{}});
  await page.route('**/api/**',r=>r.abort());
  await page.route(ORIGIN+'/__native-buffer-renderer',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0"><div id="chart" style="height:850px"></div><script src="/charting_library/charting_library.js"></script></body></html>'}));
  try{
   await page.goto(ORIGIN+'/__native-buffer-renderer');
   await page.evaluate(config=>{
    const begin=performance.now();globalThis.probe={config,begin,timeOrigin:performance.timeOrigin,requests:[],events:[],studies:[],errors:[],ready:false};
    const step=300000,last=Date.parse('2026-10-02T00:00:00Z');
    const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['5']}),0),resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'crypto',exchange:'TEST',listed_exchange:'TEST',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100,has_intraday:true,intraday_multipliers:['5'],supported_resolutions:['5'],format:'price',data_status:'streaming'}),0),
     getBars:(symbol,res,p,cb)=>{const q={at:performance.now(),symbol:symbol.name,params:{...p}};probe.requests.push(q);const n=Math.max(config.size,p.countBack);const end=Math.min(last,Math.floor((p.to*1000-1)/step)*step+step);const bars=Array.from({length:n},(_,i)=>{const time=end-(n-i)*step,v=100+Math.sin(time/step)*2;return{time,open:v,high:v+1,low:v-1,close:v+.4,volume:100};});q.generatedAt=performance.now();q.returned=n;q.jsonBytes=new TextEncoder().encode(JSON.stringify(bars)).byteLength;q.first=bars[0].time/1000;q.last=bars.at(-1).time/1000;setTimeout(()=>{q.callback=performance.now();cb(bars,{noData:false});q.callbackReturned=performance.now();},0);},subscribeBars:()=>{},unsubscribeBars:()=>{},getServerTime:cb=>cb(last/1000)};
    globalThis.widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',symbol:'BUFFER-0',interval:'5',datafeed:feed,locale:'zh',autosize:true,enabled_features:['determine_first_data_request_size_using_visible_range'],disabled_features:['use_localstorage_for_settings','header_widget','left_toolbar','create_volume_indicator_by_default','trading_account_manager'],debug:false});
    widget.onChartReady(async()=>{try{
     probe.chartReadyAt=performance.now();if(config.charts===8){widget.setLayout('8');await new Promise(r=>setTimeout(r,100));}
     probe.actualCharts=widget.chartsCount();if(probe.actualCharts!==config.charts)throw new Error('Expected '+config.charts+' charts, got '+probe.actualCharts);
     for(let i=0;i<probe.actualCharts;i++){const chart=widget.chart(i);chart.onDataLoaded().subscribe(null,()=>probe.events.push({kind:'loaded',chart:i,at:performance.now()}));if(i>0)await new Promise(r=>chart.setSymbol('BUFFER-'+i,r));probe.studies.push(await chart.createStudy('Moving Average',false,false,{length:200}));}
     const poll=()=>{if(Array.from({length:probe.actualCharts},(_,i)=>widget.chart(i).dataReady()).every(Boolean)&&probe.requests.every(q=>q.callbackReturned)){probe.dataReadyAt=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{probe.displayAt=performance.now();probe.ready=true;}));}else setTimeout(poll,5);};poll();
    }catch(e){probe.errors.push(e.message);probe.failed=true;}});
   },config);
   await page.waitForFunction(()=>probe.ready||probe.failed,null,{timeout:45000});
   const initial=await page.evaluate(()=>({...probe,snapshot:Array.from({length:probe.actualCharts||1},(_,i)=>({range:widget.chart(i).getVisibleRange(),barSpacing:widget.chart(i).getTimeScale().barSpacing(),studies:widget.chart(i).getAllStudies().map(s=>({...s,inputs:widget.chart(i).getStudyById(s.id).getInputValues()}))}))}));
   if(initial.failed)throw new Error(initial.errors.join('; '));
   const metric=await client.send('Performance.getMetrics');
   const heap=Object.fromEntries(metric.metrics.filter(m=>['JSHeapUsedSize','JSHeapTotalSize','TaskDuration','ScriptDuration','LayoutDuration'].includes(m.name)).map(m=>[m.name,m.value]));
   // A public reset in this isolated probe removes library/module startup noise.
   // This is an ingestion-cost experiment, not a proposed product preload method.
   await page.evaluate(()=>{globalThis.warm={start:performance.now(),requestIndex:probe.requests.length,ready:false};widget.resetCache();for(let i=0;i<probe.actualCharts;i++)widget.chart(i).resetData();const poll=()=>{const q=probe.requests.slice(warm.requestIndex);if(q.length>=probe.actualCharts&&q.every(r=>r.callbackReturned)&&Array.from({length:probe.actualCharts},(_,i)=>widget.chart(i).dataReady()).every(Boolean)){warm.dataReadyAt=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{warm.displayAt=performance.now();warm.ready=true;}));}else setTimeout(poll,5);};poll();});
   await page.waitForFunction(()=>warm.ready,null,{timeout:15000});
   const warmed=await page.evaluate(()=>({...warm,requests:probe.requests.slice(warm.requestIndex)}));
   await page.waitForTimeout(150);
   await page.evaluate(()=>{globalThis.dragProbe={start:performance.now(),requests:probe.requests.length,frames:[]};globalThis.dragRun=true;let last=performance.now();function tick(t){if(!dragRun)return;dragProbe.frames.push(t-last);last=t;requestAnimationFrame(tick);}requestAnimationFrame(tick);});
   await page.mouse.move(config.charts===1?280:60,config.charts===1?300:100);await page.mouse.down();await page.mouse.move(config.charts===1?880:260,config.charts===1?300:100,{steps:36});await page.mouse.up();
   await page.waitForTimeout(100);
   const drag=await page.evaluate(()=>{dragRun=false;dragProbe.end=performance.now();dragProbe.requestsAfter=probe.requests.length;dragProbe.visible=widget.chart(0).getVisibleRange();return dragProbe;});
   const tasksRaw=(await Promise.all(page.frames().map(f=>f.evaluate(()=>globalThis.__tasks||[]).catch(()=>[])))).flat();
   // Same-origin frame observers report the same renderer task in both documents.
   // Keep one copy; sub-ms origin rounding can otherwise double the total.
   const tasks=tasksRaw.filter((t,i,a)=>!a.slice(0,i).some(p=>Math.abs(p.at-t.at)<2&&p.duration===t.duration));
   const initTasks=tasks.filter(t=>t.at>=initial.timeOrigin+initial.begin&&t.at<=initial.timeOrigin+initial.displayAt);
   const warmTasks=tasks.filter(t=>t.at>=initial.timeOrigin+warmed.start&&t.at<=initial.timeOrigin+warmed.displayAt);
   const dragTasks=tasks.filter(t=>t.at>=initial.timeOrigin+drag.start&&t.at<=initial.timeOrigin+drag.end);
   const max=a=>a.length?Math.max(...a):0,sum=a=>a.reduce((s,x)=>s+x,0);
   const summary={initToDisplayMs:initial.displayAt-initial.begin,firstCallbackToDisplayMs:initial.displayAt-Math.min(...initial.requests.map(q=>q.callback)),lastCallbackToDisplayMs:initial.displayAt-Math.max(...initial.requests.map(q=>q.callback)),callbackSyncMs:sum(initial.requests.map(q=>q.callbackReturned-q.callback)),initialRequestCount:initial.requests.length,totalReturnedBars:sum(initial.requests.map(q=>q.returned)),totalJsonBytes:sum(initial.requests.map(q=>q.jsonBytes)),initLongTasks:{count:initTasks.length,totalMs:sum(initTasks.map(t=>t.duration)),maxMs:max(initTasks.map(t=>t.duration))},heap,drag:{newRequests:drag.requestsAfter-drag.requests,frames:drag.frames.length,rafMedianMs:percentile(drag.frames,.5),rafP95Ms:percentile(drag.frames,.95),rafMaxMs:max(drag.frames),framesOver50ms:drag.frames.filter(x=>x>50).length,longTaskCount:dragTasks.length,longTaskTotalMs:sum(dragTasks.map(t=>t.duration)),longTaskMaxMs:max(dragTasks.map(t=>t.duration))}};
   summary.warmIngestion={reloadToDoubleRafMs:warmed.displayAt-warmed.start,firstCallbackToDoubleRafMs:warmed.displayAt-Math.min(...warmed.requests.map(q=>q.callback)),lastCallbackToDoubleRafMs:warmed.displayAt-Math.max(...warmed.requests.map(q=>q.callback)),callbackSyncMs:sum(warmed.requests.map(q=>q.callbackReturned-q.callback)),requests:warmed.requests.length,longTaskCount:warmTasks.length,longTaskTotalMs:sum(warmTasks.map(t=>t.duration)),longTaskMaxMs:max(warmTasks.map(t=>t.duration))};
   report.samples.push({config,summary,initial,warmed,drag,tasks,tasksRaw,errors});console.log(JSON.stringify({config,summary,errors}));
  }catch(e){report.samples.push({config,error:e.message,errors,probe:await page.evaluate(()=>globalThis.probe).catch(()=>null)});console.log(JSON.stringify({config,error:e.message,errors}));}
  save();await page.close();
 }}finally{report.completed=new Date().toISOString();save();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
