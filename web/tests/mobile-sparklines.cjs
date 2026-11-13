const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/mobile/sparklines.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,{exports:exportsObject,Map,Set,Promise,AbortController,Number,Math,JSON});
const {sparklineLoader,sparklinePaths,sparklineScale,sparklineMinimumRange,sparklineDisplayPoints,sparklineWithQuote}=exportsObject;
(async()=>{
  const requests=[],received=[],failed=[];let active=0,maxActive=0;
  const loader=sparklineLoader((items,signal)=>new Promise(resolve=>{
    active++;maxActive=Math.max(maxActive,active);
    requests.push({items,signal,resolve:value=>{active--;resolve(value);}});
  }),items=>received.push(items),error=>failed.push(error));
  const old=loader.load(Array.from({length:65},(_,i)=>({ticker:'OLD'+i})));
  assert.equal(requests.length,2);assert(requests.every(request=>request.items.length<=20));
  const next=loader.load([{ticker:'NEW'},{ticker:'NEW'}]);
  assert.equal(requests.length,3);assert(requests.slice(0,2).every(request=>request.signal.aborted));
  requests[0].resolve({as_of:10,items:[{ticker:'OLD',window_end:100}]});
  requests[1].resolve({as_of:10,items:[{ticker:'OLD',window_end:100}]});
  requests[2].resolve({as_of:10,items:[{ticker:'NEW',window_end:100}]});
  await Promise.all([old,next]);assert.equal(received.length,1);assert.equal(received[0][0].ticker,'NEW');
  assert.equal(requests[2].items.length,1,'same-window items are deduplicated');
  assert.equal(failed.length,0);
  const visible=loader.load(Array.from({length:50},(_,i)=>({ticker:'VISIBLE'+i})));
  requests[3].resolve({as_of:10,items:[]});requests[4].resolve({as_of:10,items:[]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,6);assert.equal(requests[5].items.length,10);
  requests[5].resolve({as_of:100,items:[{ticker:'EXPIRED',window_end:100}]});await visible;
  assert(received.at(-1).length===0,'window that ended before server as_of is discarded');
  const paths=sparklinePaths({window_start:0,window_end:100,points:[
    {time:0,price:'1',gap_before:false},{time:10,price:'2',gap_before:false},
    {time:30,price:'3',gap_before:true}]});
  assert.equal(paths.length,2);assert.equal(paths[0].end[0],20);assert.equal(paths[1].end[0],60);
  assert(paths[1].end[0]<200,'future window remains blank instead of stretching points');
  const minutePoints=Array.from({length:31},(_,i)=>({time:i*60_000,price:String(i),gap_before:i===12}));
  const sampled=sparklineDisplayPoints({timeframe:'M1',window_start:0,window_end:31*60_000,points:minutePoints});
  assert.equal(JSON.stringify(sampled.map(point=>point.time)),JSON.stringify([4,9,11,14,19,24,29,30].map(i=>i*60_000)),'M1 display sampling keeps the latest observation in each five-minute bucket and each gap segment');
  assert.equal(sampled[3].gap_before,true,'the first sampled point after a data gap keeps the gap marker');
  assert.equal(sparklineDisplayPoints({timeframe:'M5',window_start:0,window_end:1,points:minutePoints}).length,minutePoints.length,'native non-M1 observations are not resampled');
  const intrabucketSpike={timeframe:'M1',window_start:0,window_end:5*60_000,points:[
    {time:0,price:'100',gap_before:false},{time:60_000,price:'1000',gap_before:false},
    {time:4*60_000,price:'101',gap_before:false},{time:5*60_000,price:'100',gap_before:false},
    {time:9*60_000,price:'102',gap_before:false}
  ]};
  assert(sparklineScale(intrabucketSpike,50).y(101)>40,'display scale ignores M1 observations omitted from the rendered M5 samples');
  const minutePaths=sparklinePaths({timeframe:'M1',window_start:0,window_end:31*60_000,points:minutePoints},200,50);
  assert.equal(minutePaths.length,2,'sampling does not join separate data segments');
  assert.equal(minutePaths.at(-1).end[0],minutePoints.at(-1).time/(31*60_000)*200,'the newest M1 observation remains visible');
  const dense=Array.from({length:1440},(_,i)=>({time:i,price:String(100+Math.sin(i/60)),gap_before:i===720}));
  dense[333].price='150';dense[334].price='50';
  const denseItem={window_start:0,window_end:1600,points:dense};
  const denseScale=sparklineScale(denseItem);
  const reduced=sparklinePaths(denseItem,100);
  assert.equal(reduced.length,2,'visual simplification must not join data gaps');
  const coordinates=path=>[...path.line.matchAll(/[ML]([^ML]+)/g)].map(m=>m[1].trim().split(/[ ,]+/).map(Number).slice(-2));
  const left=coordinates(reduced[0]),right=coordinates(reduced[1]);
  assert(left.length<dense.length/3,'dense chart reduces subpixel overdraw');
  assert(left.some(([x,y])=>x===20.81&&Math.abs(y-denseScale.y(150))<0.01),'one-observation peak survives');
  assert(left.some(([x,y])=>x===20.88&&Math.abs(y-denseScale.y(50))<0.01),'adjacent trough survives in chronological order');
  assert.equal(left[0][0],0);assert.equal(left.at(-1)[0],44.94);
  assert.equal(right[0][0],45);assert.equal(right.at(-1)[0],89.94,'future space remains blank');
  for(const segment of [left,right]) assert(segment.every((point,i)=>!i||point[0]>=segment[i-1][0]),'retained observations remain time ordered');
  for (const [segment, source] of [[left,dense.slice(0,720)],[right,dense.slice(720)]]) {
    for (const point of source) {
      const x=point.time/1600*100, y=denseScale.y(Number(point.price));
      let nearest=Infinity;
      for(let i=1;i<segment.length;i++) {
        const [ax,ay]=segment[i-1], [bx,by]=segment[i], dx=bx-ax,dy=by-ay;
        const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
        nearest=Math.min(nearest,Math.hypot(x-ax-t*dx,y-ay-t*dy));
      }
      assert(nearest<=0.72,'pixel simplification keeps a bounded error including rounding');
    }
  }
  const quiet=Array.from({length:1440},(_,i)=>({time:i,price:String(100+i/100+Math.sin(i)*0.015),gap_before:false}));
  const quietPaths=sparklinePaths({window_start:0,window_end:1600,points:quiet},150);
  assert(coordinates(quietPaths[0]).length<20,'subpixel noise does not create hundreds of visible corners');
  const single=sparklinePaths({window_start:0,window_end:100,points:[{time:20,price:'1',gap_before:false}]},100);
  assert.equal(coordinates(single[0]).length,2,'one observation remains visible as a stroke cap');
  const turning={window_start:0,window_end:120,points:[0,1,2,3,4,5,6].map((i)=>({time:i*15,price:String([100,104,101,106,99,103,102][i])}))};
  const straight=sparklinePaths(turning,200,50)[0];
  assert(straight.line.includes('L')&&!straight.line.includes('C'),'retained bends use the previous straight-line rendering');
  const minute=60_000, liveItem={ticker:'MWP:TEST',timeframe:'M1',window_start:0,window_end:100*minute,points:[{time:10*minute,price:'100',gap_before:false},{time:11*minute,price:'101',gap_before:false}]};
  const liveQuote={s:'ok',v:{fetch_status:'ok',lp:102,quote_time:11.5*minute}};
  const live=sparklineWithQuote(liveItem,liveQuote,12*minute);
  assert.equal(live.points.at(-1).price,'102','a received quote immediately moves the display tail');
  assert.equal(live.points.at(-1).time,11.5*minute,'quote source timestamp places the tail');
  assert.equal(liveItem.points.length,2,'temporary live point never mutates historical cache');
  assert.equal(sparklineWithQuote(liveItem,{s:'ok',v:{fetch_status:'ok',lp:103,time_type:'source_m1',data_start:11*minute}},12*minute).points.at(-1).price,'103','source M1 close uses its bar time');
  for(const bad of [
    {...liveQuote,v:{...liveQuote.v,quote_time:undefined,read_at:12*minute}},
    {...liveQuote,v:{...liveQuote.v,quote_time:9*minute}},
    {...liveQuote,v:{...liveQuote.v,quote_time:13*minute}},
    {...liveQuote,v:{...liveQuote.v,fetch_status:'stale'}},
    {...liveQuote,v:{...liveQuote.v,time_type:'source_d1'}},
    {...liveQuote,snapshot:{revision_id:'wrong'}}
  ]) assert.equal(sparklineWithQuote(liveItem,bad,12*minute),liveItem,'unknown, older, future, stale, daily and mismatched quotes must not alter the curve');
  const previousSession={...liveItem,session:{previous:true,date:'yesterday'}};
  assert.equal(sparklineWithQuote(previousSession,liveQuote,12*minute),previousSession,'previous trading day stays untouched');
  const emptyHistory={...liveItem,points:[]};
  assert.equal(sparklineWithQuote(emptyHistory,liveQuote,12*minute),emptyHistory,'a live quote alone cannot fabricate an intraday history');
  assert.equal(sparklineWithQuote(liveItem,{...liveQuote,v:{...liveQuote.v,quote_time:15*minute}},16*minute).points.at(-1).gap_before,true,'unknown missing minutes remain a gap');
  const opening={window_start:0,window_end:100,points:[{time:0,price:'1.10000'},{time:1,price:'1.10010'}]};
  const openingScale=sparklineScale(opening,50,1.1,'EURUSD');
  assert(Math.abs(openingScale.referenceY-25)<1,'reference line follows the adaptive range, not a fixed center');
  assert(Math.abs(openingScale.y(1.1001)-openingScale.y(1.1))>1.4,'small EURUSD moves become visible without filling the chart');
  assert.equal(sparklineMinimumRange('EURUSD'),0.002);
  assert.equal(sparklineMinimumRange('XAUUSD'),0.005);
  assert.equal(sparklineMinimumRange('NVDA'),0.01);
  assert.equal(sparklineMinimumRange('BTCUSDT'),0.02);
  const noReference=sparklineScale(opening,50,undefined,'EURUSD');
  assert.equal(noReference.referenceY,undefined,'first observation is not mislabeled previous close');
  assert(Math.abs(noReference.y(1.10005)-25)<0.01);
  assert.equal(sparklineScale(opening,48,NaN).referenceY,undefined);
  const gapOpen={...opening,points:[{time:0,price:'1.122'},{time:1,price:'1.123'}]};
  const gapScale=sparklineScale(gapOpen,50,1.1,'EURUSD');
  assert(gapScale.y(1.122)>30 && gapScale.y(1.122)<33,'the gapped session curve uses the available range');
  assert.equal(gapScale.referenceY,46);
  assert.equal(gapScale.referenceOutside,true,'a distant reference is marked at the edge instead of flattening intraday data');
  const formatted={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/mobile/quoteFormat.ts','utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText,{exports:formatted,Number});
  assert.equal(formatted.formatWatchPrice(1.1101243,5),'1.11012');
  assert.equal(formatted.formatWatchPrice(147.251234,3),'147.251');
  assert.equal(formatted.formatWatchPrice(690.380000,2),'690.38');
  assert.equal(formatted.formatWatchPrice(0.00000001,8),'0.00000001');
  assert.equal(formatted.formatWatchPrice(NaN,2),'—');
  assert.equal(formatted.formatWatchPrice(1.1,5), '1.10000');
  assert.equal(formatted.formatWatchPrice(147.25,3), '147.250');
  assert.equal(formatted.formatWatchPrice(1.1,4,'EURUSD'), '1.10000');
  assert.equal(formatted.formatWatchPrice(147.25,5,'USDJPY'), '147.250');
  assert.equal(formatted.watchPriceParts('1.08420').focus, '42');
  assert.equal(formatted.watchPriceParts('1.08420').tail, '0');
  // Cache-first observation followed by bounded, cancellable historical preparation.
  const prepared=new Map(), historyCalls=[], historyReceived=[];
  const cached=[0,1,2].map(i=>({ticker:'MWP:'+i,window_start:0,window_end:100,status:'partial',points:[{time:90,price:'2'}]}));
  let historyActive=0, peakHistory=0, observationsFinished=0;
  const historyLoader=sparklineLoader(async()=>({as_of:95,items:cached}), rows=>historyReceived.push(rows), error=>{throw error}, {
    prepared, request:(ticker,signal)=>new Promise(resolve=>{
      historyActive++;peakHistory=Math.max(peakHistory,historyActive);
      historyCalls.push({ticker,signal,resolve:()=>{historyActive--;resolve({as_of:95,items:[{...cached.find(row=>row.ticker===ticker),points:[{time:0,price:'1'},{time:90,price:'2'}]}],preparation:'ready'})}});
    })
  });
  const loadingHistory=historyLoader.load(cached,()=>{observationsFinished++;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(historyReceived[0][0].points[0].time,90,'existing curve is published before history finishes');
  assert.equal(historyCalls.length,2);
  assert.equal(observationsFinished,1,'visible refresh completes while historical preparation is still pending');
  const overlapping=historyLoader.load(cached,()=>{observationsFinished++;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(observationsFinished,2,'new observation poll completes independently of slow preparations');
  assert.equal(historyCalls.length,2,'overlapping observation polls deduplicate pending preparation');
  assert(historyCalls.every(call=>!call.signal.aborted),'observation polling must not cancel pending history');
  historyCalls[0].resolve();historyCalls[1].resolve();
  await new Promise(resolve=>setImmediate(resolve));
  historyCalls[2].resolve();await Promise.all([loadingHistory,overlapping]);
  assert.equal(peakHistory,2);assert.equal(prepared.size,3);
  assert.equal(historyReceived.at(-1)[0].points[0].time,0,'prepared response includes earlier same-day points');
  await historyLoader.load(cached);assert.equal(historyCalls.length,3,'already prepared day is not requested again');
  prepared.clear();const cancelled=historyLoader.load(cached);
  await new Promise(resolve=>setImmediate(resolve));historyLoader.cancel();
  const delivered=historyReceived.length;
  assert(historyCalls.slice(3).every(call=>call.signal.aborted));
  historyCalls.slice(3).forEach(call=>call.resolve());await cancelled;
  assert.equal(historyReceived.length,delivered,'late preparation cannot overwrite a new visible generation');
  // Previous plot bounds are in the past but the snapshot remains valid today.
  const prior={ticker:'MWP:NVDA',window_start:0,window_end:10,valid_until:200,
    session:{date:'2026-11-06',previous:true},status:'partial',points:[{time:1,price:'100'}]};
  const sessionReceived=[],sessionPrepared=new Map();let sessionCalls=0;
  const sessionLoader=sparklineLoader(async()=>({as_of:100,items:[prior]}),rows=>sessionReceived.push(...rows),error=>{throw error},{
    prepared:sessionPrepared,request:async()=>{sessionCalls++;return {as_of:100,items:[prior],preparation:'ready'}}
  });
  await sessionLoader.load([{ticker:prior.ticker}]);await sessionLoader.load([{ticker:prior.ticker}]);
  assert(sessionReceived.length===4,'valid previous-session curve survives batch and preparation');
  assert.equal(sessionCalls,2,'previous session must not suppress next refresh after open');
  assert.equal(sessionPrepared.size,0);
  console.log('PASS mobile sparklines: bounded batches/concurrency, deduplication, abort/late replies, window expiry and gaps');
})().catch(error=>{console.error(error);process.exitCode=1;});
