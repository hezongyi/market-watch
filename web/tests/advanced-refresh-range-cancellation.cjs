const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'../..');
const load=path=>fs.readFileSync(root+'/'+path,'utf8');
const event=()=>({subscribe(){},unsubscribe(){},unsubscribeAll(){}});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const timers=new Set();
  const ctx=vm.createContext({crypto:require('node:crypto').webcrypto,location:{search:''},URLSearchParams,
    setTimeout:(cb,ms)=>{const id=setTimeout(()=>{timers.delete(id);cb();},ms===15000?30:ms);timers.add(id);return id;},
    clearTimeout:id=>{clearTimeout(id);timers.delete(id);},requestAnimationFrame:cb=>setImmediate(cb),
    performance,queueMicrotask,CustomEvent:class{},dispatchEvent(){}});
  let navigationSource=load('advanced-host/native-navigation.js'),viewportSource=load('advanced-host/viewports.js');
  vm.runInContext(navigationSource,ctx);
  vm.runInContext(viewportSource,ctx);
  const nav=ctx.MWNativeNavigation;
  const timeScale={visibleBarsStrictRangeChanged:event};
  const series={symbol:()=> 'MWP:OANDA:AUD_JPY',onIntervalChanged:event,symbolResolved:event,
    dataEvents:()=>({completed:event,dataUpdated:event})};
  const model={mainSeries:()=>series,interval:()=> '60',timeScale:()=>timeScale,setExternalPosition(){}};
  nav.bindModel(model);await turn();
  let loaded,failed,fence,late,mutations=0,pauses=0;
  const chart={_chartWidget:{model:()=>({model:()=>model})},symbol:series.symbol,resolution:()=> '60',
    getVisibleRange:()=>({from:100,to:200}),dataReady:cb=>{cb?.();return true;},
    getTimeScale:()=>({barSpacing:()=>6,rightOffset:()=>-5,width:()=>1000,setBarSpacing(){},setRightOffset(){}}),
    onDataLoaded:()=>({subscribe:(_,cb)=>{loaded=cb;},unsubscribe:()=>{loaded=null;}}),
    onSeriesError:()=>({subscribe:(_,cb)=>{failed=cb;},unsubscribe:()=>{failed=null;}}),
    resetData:()=>setImmediate(()=>loaded?.()),
    setVisibleRange(range){
      const prepared=nav.prepareRange(model,range,()=>this.setVisibleRange(range));
      if(prepared)return prepared;
      // The installed native engine captures this same fence before its async continuation.
      const captured=fence=nav.engineRangeCurrent();
      return new Promise(resolve=>{late=()=>{if(captured())mutations++;resolve();};});
    }};
  const widget={chartsCount:()=>1,chart:()=>chart,subscribe(){},unsubscribe(){},
    _mwSyncCoordinator:{snapshot:()=>({date:false}),acquirePause:()=>{pauses++;return {release(){pauses--;}};}}};
  await assert.rejects(ctx.refreshChartHistory(widget,chart,()=>{},()=>true),/历史刷新等待超时/);
  const afterTimeout={fence:fence(),busy:nav.busy(),pauses,mutations,timers:timers.size};
  late();await turn();
  console.log(JSON.stringify({afterTimeout,afterLate:{fence:fence(),busy:nav.busy(),mutations}}));
  // These are the intended invariants. The original timeout-only implementation leaves fence/busy true.
  assert.equal(afterTimeout.fence,false,'timed-out refresh must invalidate its native range fence');
  assert.equal(afterTimeout.busy,false,'timed-out refresh must release its own native operation');
  assert.equal(mutations,0,'late engine continuation must not apply the timed-out viewport');
  {
    const peerSeries={...series,symbol:()=> 'MWP:OANDA:EUR_USD'};
    const peerModel={...model,mainSeries:()=>peerSeries,timeScale:()=>({...timeScale})};
    nav.bindModel(peerModel);await turn();
    let peerFence;
    const peer=nav.prepareRange(peerModel,{from:10,to:20},()=>{
      peerFence=nav.engineRangeCurrent();return new Promise(()=>{});
    });peer.catch(()=>{});
    const old=chart.setVisibleRange({from:100,to:200});old.catch(()=>{});
    const next=chart.setVisibleRange({from:300,to:400});next.catch(()=>{});
    assert.equal(nav.cancelRange(chart,old),false,'expired operation cannot cancel a newer user range');
    assert.equal(fence(),true);assert.equal(peerFence(),true);
    assert.equal(nav.cancelRange(chart,next),true);
    assert.equal(fence(),false);assert.equal(peerFence(),true,'another pane keeps its own active range');
    const peerChart={_chartWidget:{model:()=>({model:()=>peerModel})}};
    assert.equal(nav.cancelRange(peerChart,peer),true);
    console.log('PASS refresh: exact operation cancellation, peer isolation and stale token rejection');
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
