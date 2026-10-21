const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const events=[];
const context=vm.createContext({setTimeout,clearTimeout,queueMicrotask,
  requestAnimationFrame:callback=>setImmediate(callback),performance,
  location:{search:''},URLSearchParams,
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
  dispatchEvent:event=>events.push(event)});
vm.runInContext(fs.readFileSync('../advanced-host/native-navigation.js','utf8'),context);
const nav=context.MWNativeNavigation;
function deliverFailure(bars,error){
  const delivered={history:0,errors:[]};
  const subscriber={onHistoryCallback(){delivered.history++;},onErrorCallback:error=>delivered.errors.push(error)};
  const thread={_symbolInfo:{ticker:'MWP:OANDA:AUD_JPY'},_resolution:'60',_cache:{bars},
    _pendingSubscribers:[subscriber],_errorMessage:error,_leftDate:100,_nextTime:null,
    _dealignTime:time=>time,_moveSubscriberToRealtime:value=>value,
    _returnHistoryDataToSubscriber:value=>value.onHistoryCallback(),_subscribeRealtimeIfNeeded(){},
    _processPendingSubscribers(){
      // This is the native error-hook contract; licensed-engine integration is
      // separately exercised by advanced-native-empty-failure.private.cjs.
      for(const pending of this._pendingSubscribers)pending.onErrorCallback(this._errorMessage);
      this._pendingSubscribers=[];
    }};
  const handled=nav.historyFailure(thread,error);
  if(!handled)thread._processPendingSubscribers();
  return {thread,delivered,handled};
}
for(const code of ['NETWORK_FAILED','HISTORY_UNAVAILABLE','HISTORY_TIMEOUT']){
  const error=Object.assign(Error('read failed'),{code});
  const result=deliverFailure([],error);
  assert.equal(result.handled,false);
  assert.equal(result.delivered.history,0,'empty failed history must not masquerade as successful data');
  assert.deepEqual(result.delivered.errors,[String(error)]);
  assert.equal(result.thread._errorMessage,String(error),'adapt the failure to the vendor series-error contract');
}
const network=Object.assign(Error('read failed'),{code:'NETWORK_FAILED'});
const retained=deliverFailure([{time:100}],network);
assert.equal(retained.handled,true);assert.equal(retained.delivered.history,1);
assert.deepEqual(retained.delivered.errors,[],'accepted cached history remains recoverable');
assert.equal(retained.thread._errorMessage,null);
for(const code of ['HISTORY_CANCELLED','NATIVE_HISTORY_CAPACITY_EXCEEDED']){
  const result=deliverFailure([],Object.assign(Error(code),{code}));
  assert.equal(result.handled,true,'preserve existing cancellation/capacity handling');
}
console.log('Empty read failures preserve native error delivery; accepted cache/cancellation/capacity remain unchanged');
