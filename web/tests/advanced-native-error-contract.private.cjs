// Runtime-only private native contract probe; no licensed implementation is copied here.
// Reads the installed bundle through AST and connects the real thread error callback
// to the real main-series error receiver.
// Always verifies the worktree against the recorded error-contract baseline.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {parse}=require('@babel/parser');
const root=require('node:path').resolve(__dirname,'../..');
const source=fs.readFileSync(root+'/advanced-host/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js','utf8');
const ast=parse(source,{sourceType:'script'});
let TS,bS,readyCallback,seriesError;
function walk(node,owner){
  if(!node||typeof node!=='object')return;
  if(node.type==='ClassDeclaration')owner=node.id?.name;
  if(node.type==='ClassDeclaration'&&node.id?.name==='TS')TS=node;
  if(node.type==='ClassDeclaration'&&node.id?.name==='bS')bS=node;
  if(owner==='Rt'&&node.type==='ClassMethod'&&node.key?.name==='_onSeriesError')seriesError=node;
  if(node.type==='ObjectProperty'&&node.key?.name==='onDataReadyCallback'&&
    source.slice(node.value.start,node.value.end).includes('_recreateSourcesForDataRange'))readyCallback=node.value;
  for(const[key,value]of Object.entries(node)){
    if(key==='loc'||key==='extra')continue;
    if(Array.isArray(value))value.forEach(child=>walk(child,owner));
    else if(value&&typeof value==='object')walk(value,owner);
  }
}
walk(ast);assert.ok(TS&&bS&&readyCallback&&seriesError,'actual private native seams located');
const baseline=execFileSync('git',['show','7ba2732:advanced-host/native-navigation.js'],{cwd:root,encoding:'utf8'});

function run(name,navSource){
  const tasks=[],stats={reads:0,recreated:0,errorCallbacks:0,seriesErrors:0,completed:0};
  const ctx=vm.createContext({setTimeout:fn=>{tasks.push(fn);return tasks.length;},clearTimeout(){},
    queueMicrotask:fn=>tasks.push(fn),requestAnimationFrame:fn=>tasks.push(fn),performance:{now:()=>0},
    crypto:require('node:crypto').webcrypto,location:{search:''},URLSearchParams,
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},dispatchEvent(){},
    n:{ensure:value=>value,ensureNotNull:value=>{assert.notEqual(value,null);return value;}},
    Ne:{Interval:{isDWM:()=>false}},
    It:{lowerbound:(rows,time)=>{const index=rows.findIndex(row=>row.time>=time);return index<0?rows.length:index;}},
    c:{isFeaturesetEnabled:()=>false},CS:value=>String(value),Ib:(a,b)=>a+'|'+b,
    Rd:{alignPeriodsBackForDataRequest:(a,b,c,d,e,f,g)=>g-f*3600000,getPeriodsBetweenDates:()=>0}});
  vm.runInContext(navSource,ctx);const nav=ctx.MWNativeNavigation;
  vm.runInContext('String.prototype.format=function(...args){return this.replace(/{(\\d+)}/g,(_,i)=>args[i])}',ctx);
  const anchor='this._errorMessage=e||null,this._processPendingSubscribers()';
  const nativeThread=source.slice(TS.start,TS.end);
  assert.equal(nativeThread.split(anchor).length,2,'exact native error-hook anchor');
  vm.runInContext(source.slice(bS.start,bS.end)+';globalThis.BarSet=bS;'+nativeThread.replace(anchor,
    'this._errorMessage=e||null,globalThis.MWNativeNavigation.historyFailure(this,e)||this._processPendingSubscribers()')+
    ';globalThis.NativeThread=TS;',ctx);
  const receiveSeriesError=vm.runInContext('({'+source.slice(seriesError.start,seriesError.end)+'})._onSeriesError',ctx);
  const errorOwner={_dataEvents:{fireSeriesError:error=>{stats.seriesErrors++;stats.publicError=error.error;}}};
  const rawError=Object.assign(Error('network failure'),{code:'NETWORK_FAILED'});
  const upstream={getBars(_info,_resolution,_request,_success,failure){stats.reads++;failure(rawError);}};
  const thread=Object.create(ctx.NativeThread.prototype);
  Object.assign(thread,{_cache:{bars:[]},_symbolInfo:{ticker:'MWP:OANDA:AUD_JPY'},_resolution:'60',
    _interval:{letter:()=>'',multiplier:()=>1,isTicks:()=>false},_leftDate:null,_nextTime:null,
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
  const receiveReady=vm.runInContext('(function(){return ('+source.slice(readyCallback.start,readyCallback.end)+')})',ctx).call(engine);
  function subscribe(){
    thread.addSubscription({to:1792566200000,countBack:10},
      bars=>receiveReady(bars.bars.map(bar=>({timeMs:bar.time})),null,{},
        {firstLoadedTimeMs:bars.firstLoadedTimeMs,endOfData:bars.endOfData}),
      error=>{
        stats.errorCallbacks++;stats.nativePayloadType=typeof error;
        try{receiveSeriesError.call(errorOwner,error);}catch(failure){stats.deliveryException=failure.message;}
      });
  }
  subscribe();for(let turn=0;turn<25&&tasks.length;turn++)tasks.shift()();
  assert.equal(stats.reads,1);assert.equal(stats.recreated,0);assert.equal(stats.errorCallbacks,1);
  assert.equal(thread.mw_lastFailure.error,rawError,'diagnostics retain the original structured error');
  assert.equal(thread.mw_lastFailure.error.code,'NETWORK_FAILED');
  if(name==='baseline'){
    assert.match(stats.deliveryException,/startsWith/);assert.equal(stats.seriesErrors,0);
  }else{
    assert.equal(stats.deliveryException,undefined);assert.equal(stats.seriesErrors,1);
    assert.equal(stats.publicError,String(rawError));
    thread._updateDatesFromExpirationDate=()=>{};thread._purgeCache();
    assert.equal(thread._errorMessage,null,'actual native purge clears its delivered error');
    upstream.getBars=(_s,_r,_p,success)=>{stats.reads++;success([{time:1792562400000}],{noData:true});};
    subscribe();for(let turn=0;turn<10&&tasks.length;turn++)tasks.shift()();
    assert.equal(stats.reads,2);assert.equal(stats.completed,1);assert.equal(stats.errorCallbacks,1);
  }
  console.log(JSON.stringify({case:name,...stats}));
}
run('baseline',baseline);
run('current',fs.readFileSync(root+'/advanced-host/native-navigation.js','utf8'));
console.log('PASS: real native thread → real main-series error receiver reproduces startsWith failure; boundary adaptation delivers error and preserves retry/diagnostic semantics');
