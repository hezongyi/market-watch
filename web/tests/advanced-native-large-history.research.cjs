// Research only: original licensed v31.1, real getBars demand, synthetic transport.
// No product hooks, accounts, saved layouts, production API or database traffic.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../../advanced-host');
const OUT=process.env.LARGE_HISTORY_OUTPUT;
const ORIGINAL=process.env.LARGE_HISTORY_ORIGINAL;
if(!OUT||!ORIGINAL)throw Error('Set LARGE_HISTORY_OUTPUT and LARGE_HISTORY_ORIGINAL');
fs.mkdirSync(OUT,{recursive:true});
assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(ORIGINAL)).digest('hex'),'114428b8dde6eb137fd7ef3bc20ef35882189186c4bd092bb743b64d11682be1');
let BASE='https://large-history.test';
const configs=JSON.parse(process.env.LARGE_HISTORY_CASES||JSON.stringify([
 ...[20000,60000,200000,1000000].map(size=>({size,charts:1,studies:0})),
 ...[20000,60000,200000].map(size=>({size,charts:1,studies:3})),
 ...[20000,60000,200000].map(size=>({size,charts:4,studies:3})),
 {size:200000,charts:4,studies:3,mixed:true},
]));
const percentile=(a,p)=>a.length?[...a].sort((a,b)=>a-b)[Math.floor((a.length-1)*p)]:null;
const sum=a=>a.reduce((n,x)=>n+x,0);
(async()=>{
 let server;
 if(process.env.LARGE_HISTORY_REAL_TRANSPORT!=='0'){
  server=require('node:http').createServer((request,response)=>{
   const u=new URL(request.url,'http://localhost');if(u.pathname!=='/data'){response.writeHead(404);response.end();return;}
   const q=JSON.parse(u.searchParams.get('q'));if(q.provider){
    fetch('http://127.0.0.1:16145/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({countBack:q.count,before:q.to*1000,from:q.from*1000})}).then(async r=>{const body=await r.text();response.writeHead(r.status,{'Content-Type':'application/json'});response.end(body);}).catch(e=>{response.writeHead(503);response.end(JSON.stringify({error:String(e)}));});return;
   }
   const step=q.step,end=Math.min(Date.parse('2026-10-04T00:00:00Z'),Math.ceil(q.to*1000/step)*step);
   const bars=Array.from({length:q.count},(_,i)=>{const time=end-(q.count-i)*step,v=Math.round((100+Math.sin(time/step)*2)*1e5)/1e5;return{time,open:v,high:v+1,low:v-1,close:v+.4,volume:100};});
   const body=JSON.stringify(bars);setTimeout(()=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(body);},q.delay||0);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));BASE='http://127.0.0.1:'+server.address().port;
 }
 const B=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const report={scope:'Original v31.1 library, public setVisibleRange requests full historical corridor; synthetic 24x7 bars delivered as JSON via intercepted fetch. No product changes.',browser:B.version(),viewport:{width:1600,height:1000},cpuRate:Number(process.env.LARGE_HISTORY_CPU_RATE||1),cases:[]};
 const save=()=>fs.writeFileSync(OUT+'/results.json',JSON.stringify(report,null,2));
 try{for(const config of configs){
  const item={config,transport:[],errors:[]};report.cases.push(item);save();
  const C=await B.newContext({viewport:report.viewport});const P=await C.newPage();const cdp=await C.newCDPSession(P);
  await cdp.send('Performance.enable');if(report.cpuRate!==1)await cdp.send('Emulation.setCPUThrottlingRate',{rate:report.cpuRate});
  await P.addInitScript(()=>{globalThis.__tasks=[];new PerformanceObserver(l=>{for(const e of l.getEntries())__tasks.push({at:performance.timeOrigin+e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:true});});
  P.on('pageerror',e=>item.errors.push(e.message));
  await C.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.origin!==BASE)return route.abort();
   if(u.pathname==='/probe')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0"><div id="chart" style="height:950px"></div><script src="/charting_library/charting_library.js"></script></body></html>'});
   if(u.pathname==='/data'){
    if(server)return route.continue();
    const q=JSON.parse(u.searchParams.get('q')),step=q.step,end=Math.min(Date.parse('2026-10-04T00:00:00Z'),Math.ceil(q.to*1000/step)*step);
    const began=performance.now(),bars=Array.from({length:q.count},(_,i)=>{const time=end-(q.count-i)*step,v=Math.round((100+Math.sin(time/step)*2)*1e5)/1e5;return{time,open:v,high:v+1,low:v-1,close:v+.4,volume:100};});
    const body=JSON.stringify(bars);item.transport.push({q,bytes:Buffer.byteLength(body),generateSerializeMs:performance.now()-began});
    if(q.delay)await new Promise(r=>setTimeout(r,q.delay));
    return route.fulfill({contentType:'application/json',body});
   }
   const file=path.resolve(ROOT,'.'+u.pathname);if(!file.startsWith(ROOT+'/charting_library/')||!fs.existsSync(file))return route.abort();
   let body=fs.readFileSync(file);if(u.pathname.includes('/bundles/library.')){
    let s=fs.readFileSync(ORIGINAL,'utf8');const a='s&&this._drawSources(e,t)}if(null!==this._state)';assert.equal(s.split(a).length,2);
    s=s.replace(a,'s&&(this._drawSources(e,t),(()=>{const m=this.state().model();if(this.containsMainSeries())(globalThis.__models??=new Map).set(m.id(),{m,canvas:e.canvas});})())}if(null!==this._state)');body=Buffer.from(s);
    const threadAnchor='this._datafeed=e,this._symbolInfo=t,this._interval=Ne.Interval.parse(i)';assert.equal(s.split(threadAnchor).length,2);
    s=s.replace(threadAnchor,'this._datafeed=e,this._symbolInfo=t,(globalThis.__threads??=new Set).add(this),this._interval=Ne.Interval.parse(i)');body=Buffer.from(s);
   }
   return route.fulfill({body,contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});
  });
  const memory=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter(m=>['JSHeapUsedSize','JSHeapTotalSize','TaskDuration','ScriptDuration'].includes(m.name)).map(m=>[m.name,m.value]));
  try{
   await P.goto(BASE+'/probe');
   await P.evaluate(config=>{
    const end=config.end||Date.parse('2026-10-04T00:00:00Z');globalThis.trace=[];globalThis.stage='startup';globalThis.pending=0;globalThis.subs=new Map();globalThis.ready=false;globalThis.delayMs=0;
    const steps={'5':300000,'240':14400000,'1D':86400000,'1W':604800000};
    const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:Object.keys(steps)}),0),resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:config.provider?'forex':'crypto',exchange:'RESEARCH',session:config.provider?'1700-1700:23456':'24x7',timezone:config.provider?'America/New_York':'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,intraday_multipliers:['5','240'],has_daily:true,has_weekly_and_monthly:true,supported_resolutions:Object.keys(steps),format:'price',data_status:'streaming'}),0),getServerTime:cb=>cb(end/1000),
     getBars:(s,res,p,cb,err)=>{
      const q={stage,symbol:s.name,res,p:{...p},start:performance.now(),timeOrigin:performance.timeOrigin};trace.push(q);pending++;
      if(globalThis.failNext){failNext=false;setTimeout(()=>{pending--;q.error='injected 503';err('injected 503');},100);return;}
      const count=Math.ceil(p.countBack),step=steps[res];
      fetch('/data?q='+encodeURIComponent(JSON.stringify({count,step,to:p.to,from:p.from,delay:delayMs,provider:config.provider}))).then(async response=>{q.headersAt=performance.now();if(!response.ok)throw Error('HTTP '+response.status);const text=await response.text();q.bytes=text.length;q.bodyAt=performance.now();const parsed=JSON.parse(text);q.jsonParsedAt=performance.now();const bars=config.provider?parsed.bars.map(b=>({time:b.chart_time,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume)})):parsed;q.cache_hit=parsed.cache_hit;q.parsedAt=performance.now();q.count=bars.length;q.first=bars[0]?.time;q.last=bars.at(-1)?.time;setTimeout(()=>{q.callback=performance.now();try{cb(bars,{noData:config.provider?parsed.history_boundary:false});q.callbackReturned=performance.now();}finally{pending--;q.done=performance.now();}},0);}).catch(e=>{pending--;q.error=String(e);err(String(e));});
     },subscribeBars:(s,res,cb,id,reset)=>subs.set(id,{s,res,cb,reset}),unsubscribeBars:id=>subs.delete(id)};
    globalThis.widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',symbol:'RESEARCH-0',interval:'5',datafeed:feed,locale:'zh',autosize:true,enabled_features:['determine_first_data_request_size_using_visible_range',...(config.visibleReset?['request_only_visible_range_on_reset']:[])],disabled_features:['use_localstorage_for_settings','header_widget','left_toolbar','create_volume_indicator_by_default','trading_account_manager']});
    widget.onChartReady(async()=>{try{
     if(config.charts>1){widget.setLayout(config.charts===2?'2h':String(config.charts));await new Promise(r=>setTimeout(r,150));widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.dateRangeSync().setValue(false);widget.timeSync().setValue(false);}
     if(widget.chartsCount()!==config.charts)throw Error('Wrong layout');
     for(let i=0;i<config.charts;i++){
      const chart=widget.chart(i);if(i>0)await new Promise(r=>chart.setSymbol('RESEARCH-'+i,r));if(config.mixed&&i>0)await chart.setResolution(['5','240','1D','1W'][i]);
      for(const [name,inputs] of [['Moving Average',{length:200}],['Relative Strength Index',{length:14}],['MACD',{}]].slice(0,config.studies))await chart.createStudy(name,false,false,inputs);
     }ready=true;
    }catch(e){globalThis.setupError=String(e);ready=true;}});
    globalThis.snapshot=()=>({stage,pending,requests:trace.length,charts:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),res:widget.chart(i).resolution(),range:widget.chart(i).getVisibleRange(),ready:widget.chart(i).dataReady(),studies:widget.chart(i).getAllStudies().length}))});
   },config);
   await P.waitForFunction(()=>ready&&pending===0&&snapshot().charts.every(c=>c.ready),null,{timeout:90000});
   const setupError=await P.evaluate(()=>globalThis.setupError);if(setupError)throw Error(setupError);
   await P.waitForTimeout(200);item.initial={snapshot:await P.evaluate(()=>snapshot()),heap:await memory()};
   const native=P.frames().find(f=>f!==P.mainFrame());assert.ok(native);
   const nativeSnap=()=>native.evaluate(()=>[...(__models||new Map).values()].filter(v=>v.canvas.isConnected).map(({m,canvas})=>{const s=m.mainSeries(),b=s.bars(),ts=m.timeScale();return{symbol:s.symbol(),res:m.interval(),bars:b.size(),first:b.firstIndex(),last:b.lastIndex(),spacing:ts.barSpacing(),requesting:ts._requestingMoreData,threads:[...(__threads||new Set)].filter(t=>t._symbolInfo.ticker===s.symbol()).map(t=>({destroyed:t._destroyed,requesting:t._requesting,error:t._errorMessage,cacheBars:t._cache?.bars?.length})),rect:canvas.getBoundingClientRect().toJSON()};}));
   item.initial.native=await nativeSnap();
   await P.evaluate(config=>{
    stage='jump';delayMs=config.delay||0;globalThis.jumpStart=performance.now();globalThis.jumpDone=false;globalThis.jumpErrors=[];
    const end=(config.end||Date.parse('2026-10-04T00:00:00Z'))/1000,target=config.target||end-config.size*300;
    globalThis.target=target;
    Promise.all(Array.from({length:config.charts},(_,i)=>widget.chart(i).setVisibleRange({from:target-70*300,to:target+70*300},{rejectByTimeout:120000}).catch(e=>jumpErrors.push(String(e))))).then(()=>{jumpDone=true;globalThis.jumpEnd=performance.now();});
   },config);
   if(config.delay){
    await P.waitForTimeout(250);item.waiting={snapshot:await P.evaluate(()=>snapshot())};
    item.waiting.raf=await P.evaluate(()=>new Promise(resolve=>{const a=[];let old=performance.now();function tick(now){a.push(now-old);old=now;if(a.length===30)resolve(a);else requestAnimationFrame(tick);}requestAnimationFrame(tick);}));
    await P.screenshot({path:OUT+'/waiting-'+config.size+'.png'});
    item.waiting.loadingElements=await native.evaluate(()=>[...document.querySelectorAll('[class]')].filter(e=>/load|spinner|dots/i.test(e.className)&&e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>e.outerHTML.slice(0,350)).slice(0,15));
   }
   await P.waitForFunction(()=>jumpDone&&pending===0&&snapshot().charts.every(c=>c.ready),null,{timeout:150000});
   await P.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   item.jump=await P.evaluate(()=>({start:jumpStart,end:jumpEnd,target,errors:jumpErrors,snapshot:snapshot(),requests:trace.filter(q=>q.stage==='jump'),displayAt:performance.now()}));
   item.jump.heap=await memory();item.jump.native=await nativeSnap();
   assert.ok(item.jump.requests.some(q=>q.p.countBack>=Math.max(1,config.size*.95-500)),'Experiment did not exercise genuinely large countBack');
   assert.ok(item.jump.snapshot.charts.every(c=>{
    const allowance=c.res==='1W'?604800:c.res==='1D'?86400:c.res==='240'?14400:0;
    return c.range.from<=item.jump.target+allowance&&c.range.to>=item.jump.target-allowance;
   }),'Target missing from visible range after native higher-period mapping');
   const runDrag=async(name,amount)=>{
    for(const f of P.frames())await f.getByText('了解！',{exact:true}).click({timeout:200}).catch(()=>{});
    const before=await P.evaluate(name=>{stage=name;globalThis.dragFrames=[];globalThis.dragOn=true;globalThis.dragStart=performance.now();let old=performance.now();function frame(now){if(!dragOn)return;dragFrames.push(now-old);old=now;requestAnimationFrame(frame);}requestAnimationFrame(frame);return snapshot();},name);
    const models=await nativeSnap(),rect=models.find(m=>m.symbol==='RESEARCH-0').rect,box=await(await native.frameElement()).boundingBox();
    const x=box.x+rect.x+rect.width*.5,y=box.y+rect.y+rect.height*.65;
    await P.mouse.move(x,y);await P.mouse.down();await P.mouse.move(x+amount,y,{steps:36});await P.mouse.up();await P.waitForTimeout(150);
    await P.waitForFunction(()=>pending===0,null,{timeout:45000});
    await P.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    return {name,before,coordinates:{x,y,rect,box},native:await nativeSnap(),...await P.evaluate(()=>{dragOn=false;return{start:dragStart,end:performance.now(),frames:dragFrames,snapshot:snapshot()};})};
   };
   item.drags=[await runDrag('drag-older',config.charts===1?500:180),await runDrag('drag-newer',config.charts===1?-500:-180)];
   if(!item.drags.some(d=>Math.abs(d.before.charts[0].range.from-d.snapshot.charts[0].range.from)>300)){
    await P.screenshot({path:OUT+'/'+config.size+'-drag-failed.png'});
    throw Error('Mouse did not move chart');
   }
   await P.evaluate(()=>{stage='repeat-cached';globalThis.repeatStart=performance.now();globalThis.repeatDone=false;widget.chart(0).setVisibleRange({from:target-70*300,to:target+70*300}).then(()=>{repeatDone=true;globalThis.repeatEnd=performance.now();});});
   await P.waitForFunction(()=>repeatDone&&pending===0,null,{timeout:30000});
   item.repeat=await P.evaluate(()=>({ms:repeatEnd-repeatStart,requests:trace.filter(q=>q.stage==='repeat-cached'),snapshot:snapshot()}));
   if(config.ticks){
    item.realtime=await P.evaluate(async config=>{
     stage='realtime';const start=performance.now(),samples=[],before=trace.length;
     const end=Date.parse('2026-10-04T00:00:00Z'),time=end-300000;
     for(let i=0;i<100;i++){
      const began=performance.now();for(const sub of subs.values())sub.cb({time,open:100,high:103,low:97,close:100+i/100,volume:100+i});samples.push(performance.now()-began);
      await new Promise(r=>setTimeout(r,20));
     }return{start,end:performance.now(),samples,newRequests:trace.length-before,snapshot:snapshot()};
    },config);
   }
   if(config.redirect){
    await P.evaluate(()=>{stage='redirect-old';delayMs=2500;globalThis.oldRedirect=widget.chart(0).setVisibleRange({from:target-60000*300,to:target-60000*300+140*300},{rejectByTimeout:5000}).then(()=>({ok:true}),e=>({error:String(e)}));});
    await P.waitForFunction(()=>trace.some(q=>q.stage==='redirect-old'),null,{timeout:5000});
    await P.evaluate(range=>{stage='redirect-latest';delayMs=0;globalThis.redirectStart=performance.now();globalThis.latestRedirect=widget.chart(0).setVisibleRange(range,{rejectByTimeout:5000}).then(()=>({ok:true,ms:performance.now()-redirectStart}),e=>({error:String(e)}));},item.initial.snapshot.charts[0].range);
    await P.waitForTimeout(5500);
    item.redirect={old:await P.evaluate(()=>oldRedirect),latest:await P.evaluate(()=>latestRedirect),snapshot:await P.evaluate(()=>snapshot()),desired:item.initial.snapshot.charts[0].range};
   }
   if(config.reset){
    await P.evaluate(()=>{stage='reset';delayMs=0;globalThis.resetStart=performance.now();widget.resetCache();widget.chart(0).resetData();});
    await P.waitForFunction(()=>trace.some(q=>q.stage==='reset')&&pending===0&&widget.chart(0).dataReady(),null,{timeout:90000});
    await P.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await P.waitForTimeout(150);await P.waitForFunction(()=>pending===0&&widget.chart(0).dataReady(),null,{timeout:90000});
    item.reset={...await P.evaluate(()=>({ms:performance.now()-resetStart,requests:trace.filter(q=>q.stage==='reset'),snapshot:snapshot()})),native:await nativeSnap()};
    await P.evaluate(()=>{stage='restore-after-reset';globalThis.restoreStarted=performance.now();globalThis.restoreDone=false;widget.chart(0).setVisibleRange({from:target-70*300,to:target+70*300}).then(()=>restoreDone=true);});
    await P.waitForFunction(()=>restoreDone&&pending===0&&widget.chart(0).dataReady(),null,{timeout:90000});
    item.reset.restore={...await P.evaluate(()=>({ms:performance.now()-restoreStarted,requests:trace.filter(q=>q.stage==='restore-after-reset'),snapshot:snapshot()})),native:await nativeSnap()};
   }
   if(config.size===60000&&config.charts===1&&config.studies===0&&!config.redirect){
    // Obsolete request followed by a symbol change: the original adapter owns retirement.
    await P.evaluate(()=>{stage='cancel';delayMs=2500;globalThis.cancelRange={from:target-60000*300,to:target-60000*300+140*300};globalThis.cancelPromise=widget.chart(0).setVisibleRange(cancelRange,{rejectByTimeout:5000}).then(()=>({ok:true}),e=>({error:String(e)}));});
    await P.waitForFunction(()=>trace.some(q=>q.stage==='cancel'),null,{timeout:5000});
    const started=Date.now();await P.evaluate(()=>{stage='replacement';delayMs=0;widget.chart(0).setSymbol('REPLACEMENT',()=>globalThis.replacementDone=true);});
    await P.waitForFunction(()=>globalThis.replacementDone&&widget.chart(0).dataReady(),null,{timeout:15000});await P.waitForTimeout(2800);
    item.cancel={replacementMs:Date.now()-started-2800,result:await P.evaluate(()=>cancelPromise),snapshot:await P.evaluate(()=>snapshot()),native:await nativeSnap()};
    // Recoverability after a getBars failure without product recovery hooks.
    await P.evaluate(()=>{stage='failure';globalThis.failNext=true;globalThis.failedNavigation=widget.chart(0).setVisibleRange(cancelRange,{rejectByTimeout:5000}).then(()=>({ok:true}),e=>({error:String(e)}));});
    await P.waitForTimeout(5500);item.failure={result:await P.evaluate(()=>failedNavigation),native:await nativeSnap(),snapshot:await P.evaluate(()=>snapshot())};
    await P.evaluate(()=>{stage='after-failure';globalThis.recoveryNavigation=widget.chart(0).setVisibleRange({from:cancelRange.from-10000*300,to:cancelRange.to-10000*300},{rejectByTimeout:5000}).then(()=>({ok:true}),e=>({error:String(e)}));});
    await P.waitForTimeout(5500);item.failure.next={result:await P.evaluate(()=>recoveryNavigation),native:await nativeSnap(),snapshot:await P.evaluate(()=>snapshot()),requests:await P.evaluate(()=>trace.filter(q=>q.stage==='after-failure'))};
   }
   await P.screenshot({path:OUT+'/'+config.size+'-'+config.charts+'-'+config.studies+(config.mixed?'-mixed':'')+'.png'});
   item.trace=await P.evaluate(()=>trace);
   const raw=(await Promise.all(P.frames().map(f=>f.evaluate(()=>globalThis.__tasks||[])))).flat();item.longTasks=raw.filter((t,i,a)=>!a.slice(0,i).some(p=>Math.abs(p.at-t.at)<2&&p.duration===t.duration));
   const taskSummary=(start,end)=>{const a=item.longTasks.filter(t=>t.at>=start&&t.at<=end);return{count:a.length,totalMs:sum(a.map(t=>t.duration)),maxMs:Math.max(0,...a.map(t=>t.duration))};};
   const origin=item.jump.requests[0].timeOrigin;
   item.summary={jumpMs:item.jump.displayAt-item.jump.start,maxCountBack:Math.max(...item.jump.requests.map(q=>q.p.countBack)),returnedBars:sum(item.jump.requests.map(q=>q.count||0)),bytes:sum(item.jump.requests.map(q=>q.bytes||0)),parseMs:sum(item.jump.requests.map(q=>q.parsedAt-q.bodyAt)),callbackSyncMs:sum(item.jump.requests.map(q=>q.callbackReturned-q.callback)),longTasks:taskSummary(origin+item.jump.start,origin+item.jump.displayAt),heapMiB:item.jump.heap.JSHeapUsedSize/1048576,nativeBars:item.jump.native.map(m=>m.bars),drags:item.drags.map(d=>({name:d.name,newRequests:d.snapshot.requests-d.before.requests,p95Ms:percentile(d.frames,.95),maxMs:Math.max(...d.frames),over50ms:d.frames.filter(t=>t>50).length,longTasks:taskSummary(origin+d.start,origin+d.end)})),repeatMs:item.repeat.ms,repeatRequests:item.repeat.requests.length};
   item.passed=true;console.log(JSON.stringify({config,summary:item.summary,cancel:item.cancel?.result,failure:item.failure?.result,recovery:item.failure?.next?.result}));
  }catch(e){item.error=String(e);console.error(JSON.stringify({config,error:item.error}));item.snapshot=await P.evaluate(()=>globalThis.snapshot?.()).catch(()=>null);item.trace=await P.evaluate(()=>globalThis.trace).catch(()=>null);}
  save();await C.close();
 }}finally{report.completed=new Date().toISOString();save();await B.close();if(server)await new Promise(r=>server.close(r));}
 if(report.cases.some(c=>!c.passed))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
