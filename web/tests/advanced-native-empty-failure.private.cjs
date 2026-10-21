// Local-only regression: reads private vendor code at runtime; contains no copied licensed implementation.
// Requires the pinned local licensed bundle and @babel/parser. Not run in public CI.
// Uses real native thread/barset/main callback, with a controlled upstream and source recreation boundary.
// Cancellation/capacity behavior is reported as an existing boundary, not claimed fixed.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
process.on('uncaughtException',error=>{console.error(error.stack);process.exitCode=1;});
const {parse}=require('@babel/parser');
const root=require('node:path').resolve(__dirname,'../..');
const source=fs.readFileSync(root+'/advanced-host/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js','utf8');
const ast=parse(source,{sourceType:'script'});let TS,bS,callback;
function walk(n){
  if(!n||typeof n!=='object')return;
  if(n.type==='ClassDeclaration'&&n.id?.name==='TS')TS=n;
  if(n.type==='ClassDeclaration'&&n.id?.name==='bS')bS=n;
  if(n.type==='ObjectProperty'&&n.key?.name==='onDataReadyCallback'&&
    source.slice(n.value.start,n.value.end).includes('_recreateSourcesForDataRange'))callback=n.value;
  for(const [k,v]of Object.entries(n)){
    if(k==='loc'||k==='extra')continue;
    if(Array.isArray(v)){for(const x of v)walk(x);}
    else if(v&&typeof v==='object')walk(v);
  }
}
walk(ast);assert.ok(TS&&bS&&callback,'actual private native seams found');
function run({baseline=false,code='HISTORY_UNAVAILABLE',cached=false}){
  const tasks=[],events=[],stats={reads:0,recreated:0,errors:0,completed:0};
  const navSource=baseline
    ? execFileSync('git',['show','783661f:advanced-host/native-navigation.js'],{cwd:root,encoding:'utf8'})
    : fs.readFileSync(root+'/advanced-host/native-navigation.js','utf8');
  const ctx=vm.createContext({setTimeout:fn=>{tasks.push(fn);return tasks.length;},clearTimeout(){},
    queueMicrotask:fn=>tasks.push(fn),requestAnimationFrame:fn=>tasks.push(fn),performance:{now:()=>0},
    crypto:require('node:crypto').webcrypto,location:{search:''},URLSearchParams,
    CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}},dispatchEvent:e=>events.push(e),
    n:{ensure:x=>x,ensureNotNull:x=>{assert.notEqual(x,null);return x;}},Ne:{Interval:{isDWM:()=>false}},
    It:{lowerbound:(rows,time)=>{const i=rows.findIndex(r=>r.time>=time);return i<0?rows.length:i;}},
    c:{isFeaturesetEnabled:()=>false},CS:x=>String(x),Ib:(e,s)=>e+'|'+s,
    Rd:{alignPeriodsBackForDataRequest:(a,b,c,d,e,f,g)=>g-f*3600000,getPeriodsBetweenDates:()=>0}});
  vm.runInContext(navSource,ctx);const nav=ctx.MWNativeNavigation;
  vm.runInContext('String.prototype.format=function(...args){return this.replace(/{(\\d+)}/g,(_,i)=>args[i])}',ctx);
  const anchor='this._errorMessage=e||null,this._processPendingSubscribers()';
  const nativeTS=source.slice(TS.start,TS.end);
  assert.equal(nativeTS.split(anchor).length,2,'exact native error-hook anchor');
  vm.runInContext(source.slice(bS.start,bS.end)+';globalThis.BarSet=bS;'+
    nativeTS.replace(anchor,'this._errorMessage=e||null,globalThis.MWNativeNavigation.historyFailure(this,e)||this._processPendingSubscribers()')+
    ';globalThis.NativeThread=TS;',ctx);
  const thread=Object.create(ctx.NativeThread.prototype);
  const upstream={getBars(info,res,p,success,failure){stats.reads++;failure(Object.assign(Error('network failure'),{code}));}};
  Object.assign(thread,{_cache:{bars:cached?[{time:1792562400000}]:[]},_symbolInfo:{ticker:'MWP:OANDA:AUD_JPY'},_resolution:'60',
    _interval:{letter:()=>'',multiplier:()=>1,isTicks:()=>false},_leftDate:cached?1792562400000:null,_nextTime:null,
    _requesting:false,_firstDataRequest:true,_destroyed:false,_pendingSubscribers:[],_subscribers:[],
    _nextSubscriptionId:0,_dwmAligner:null,_endOfData:false,_emptyResponsesCount:0,_now:()=>1792566200000,
    _logMessage(){},_clearResetCacheTimeout(){},_subscribeRealtimeIfNeeded(){},_datafeed:upstream});
  thread._checkBars=thread._alignBarsTime=()=>{};
  thread._putToCache=rows=>{thread._cache.bars=rows;return true;};
  nav.bindThread(thread,'60');
  const engine={_studiesCache:{session:{series:{isMain:true}}},_updateMainTsBuilder(){},
    _clearSeriesData(){},_updateTimeScaleState(){},_setEndOfData(){},_logMessage(){},
    _symbolIdToSymbolRequestString:new Map([['session|symbol','symbol']]),_barsCoefficients:()=>({}),
    _chartApiMessagerProvider:{getChartApiMessager:()=>({onSeriesCompleted(){stats.completed++;}})},
    _recreateSourcesForDataRange(){stats.recreated++;subscribe();}};
  Object.assign(ctx,{e:'session',t:'series',s:'symbol',i:'turnaround',r:'60',a:false,m(){}});
  const cb=vm.runInContext('(function(){return ('+source.slice(callback.start,callback.end)+')})',ctx).call(engine);
  function subscribe(){thread.addSubscription({to:1792566200000,countBack:10},
    barset=>{try{return cb(barset.bars.map(b=>({timeMs:b.time})),null,{}, {firstLoadedTimeMs:barset.firstLoadedTimeMs,endOfData:barset.endOfData});}catch(error){stats.callbackError=error.stack;throw error;}},
    error=>{stats.errors++;stats.lastError=String(error);});}
  subscribe();for(let turn=0;turn<25&&tasks.length;turn++)tasks.shift()();
  const result={baseline,code,cached,...stats,tasks:tasks.length,pending:thread._pendingSubscribers.length,errorStored:!!thread._errorMessage};
  if(!baseline&&code==='HISTORY_UNAVAILABLE'&&!cached){
    assert.equal(stats.reads,1);assert.equal(stats.recreated,0);assert.equal(stats.errors,1);
    // Existing reset/purge clears the cached error and permits another real getBars.
    thread._updateDatesFromExpirationDate=()=>{};thread._purgeCache();
    assert.equal(thread._errorMessage,null);const reads=stats.reads;
    upstream.getBars=(_s,_r,_p,success)=>{stats.reads++;success([{time:1792562400000}],{noData:true});};
    subscribe();for(let turn=0;turn<10&&tasks.length;turn++)tasks.shift()();
    assert.equal(stats.reads,reads+1);assert.equal(stats.completed,1,JSON.stringify(stats));assert.equal(stats.errors,1);
    result.readsAfterPurge=stats.reads;result.completedAfterPurge=stats.completed;
  }
  console.log(JSON.stringify(result));return result;
}
const red=run({baseline:true});assert.ok(red.reads>1&&red.recreated>1&&red.errors===0);
run({});
const retained=run({cached:true});assert.equal(retained.recreated,0);assert.equal(retained.errors,0);
for(const code of ['HISTORY_CANCELLED','NATIVE_HISTORY_CAPACITY_EXCEEDED'])run({code});
