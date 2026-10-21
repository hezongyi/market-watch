const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

async function stalledRestore(stall){
  let loaded,failed,ready=false,pauses=0,mutations=0;
  const timers=new Set(),events=new Map(),wheel=new Map();
  const context=vm.createContext({
    setTimeout:(callback,ms)=>{
      const timer=setTimeout(()=>{timers.delete(timer);callback();},ms===15000?25:ms);
      timers.add(timer);return timer;
    },
    clearTimeout:timer=>{timers.delete(timer);clearTimeout(timer);},
    requestAnimationFrame:callback=>setImmediate(callback),
    document:{querySelectorAll:()=>[],addEventListener:(name,fn)=>wheel.set(name,fn),
      removeEventListener:name=>wheel.delete(name)},
  });
  vm.runInContext(fs.readFileSync('../advanced-host/viewports.js','utf8'),context);
  const readyCallbacks=[];
  const chart={symbol:()=> 'MWP:OANDA:AUD_JPY',resolution:()=> '60',
    getVisibleRange:()=>({from:100,to:200}),
    getTimeScale:()=>({barSpacing:()=>6,rightOffset:()=>-5,width:()=>1000,
      setBarSpacing(){mutations++;},setRightOffset(){mutations++;}}),
    dataReady:callback=>{if(callback){if(ready)callback();else readyCallbacks.push(callback);}return ready;},
    onDataLoaded:()=>({subscribe:(_,callback)=>{loaded=callback;},unsubscribe:()=>{loaded=null;}}),
    onSeriesError:()=>({subscribe:(_,callback)=>{failed=callback;},unsubscribe:()=>{failed=null;}}),
    resetData:()=>{
      ready=stall==='visible-range';
      setImmediate(()=>stall==='series-error'?failed?.(Error('network read failed')):loaded?.());
    },
    setVisibleRange:()=>stall==='visible-range'?new Promise(()=>{}):Promise.resolve(),
  };
  const widget={chartsCount:()=>1,chart:()=>chart,
    subscribe:(name,callback)=>events.set(name,callback),unsubscribe:name=>events.delete(name),
    _mwSyncCoordinator:{snapshot:()=>({date:false}),acquirePause:()=>{
      pauses++;let released=false;
      return {release(){if(!released){released=true;pauses--;}}};
    }},
  };
  let watchdog;
  try{
    const result=context.refreshChartHistory(widget,chart,()=>{},()=>true);
    await assert.rejects(Promise.race([result,new Promise((_,reject)=>{
      watchdog=setTimeout(()=>reject(Error('refresh remained pending beyond its whole-operation budget')),150);
    })]),stall==='series-error'?/network read failed/:/历史刷新等待超时/);
    assert.equal(pauses,0,'failed restoration must release synchronization pauses');
    assert.equal(events.size,0);assert.equal(wheel.size,0);assert.equal(loaded,null);assert.equal(failed,null);
    assert.equal(timers.size,0,'refresh must clear its timer');
    const previous=mutations;
    ready=true;
    for(const callback of readyCallbacks)callback();
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(mutations,previous,'late readiness must not mutate a timed-out viewport');
  }finally{
    clearTimeout(watchdog);
    for(const timer of timers)clearTimeout(timer);
  }
}
(async()=>{
  await stalledRestore('data-ready');
  await stalledRestore('visible-range');
  await stalledRestore('series-error');
  console.log('History refresh bounds readiness/range restoration and releases all listeners/pauses');
})().catch(error=>{console.error(error);process.exit(1);});
