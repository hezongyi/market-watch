/* Main-chart ranges drive Python demand. One read includes all plots; shared
 * results stay time-keyed until the native adapter maps them to current indexes. */
function chartIndicatorCoordinator(widget,catalog,{read,identity,recover,report=()=>{},occurrence=()=>{},recovered=()=>{},status=()=>{},presentation=()=>{},demand=()=>{},leases=()=>{},release=()=>{},drawings}={}) {
  const results=globalThis.MWNativeIndicatorResults;
  read=chartIndicatorReadBatch(read);
  const consumers=new Map(),shared=new Map(),charts=new WeakMap(),rangeEvents=new Map(),operations=new Set();
  let chartSequence=0;
  let disposed=false,timer,syncQueued=false,demandSignature,leaseSignature,leaseRenewed=0;
  function publishDemand(){
    const origins=new Map();
    for(const consumer of consumers.values()){
      const ticker=consumer.chart.symbol(),resolution=consumer.chart.resolution();
      const binding=identity.binding(ticker,resolution),origin=binding?.calculationStart;
      if(!Number.isFinite(origin))continue;
      const key=ticker+'|'+resolution,old=origins.get(key);
      origins.set(key,{ticker,resolution,origin:Math.min(old?.origin ?? Infinity,origin),
        ...(binding.dependencyRevision ? {dependencyBefore:binding.dependencyBefore,dependencyRevision:binding.dependencyRevision} : {})});
    }
    const rows=[...origins.values()].sort((a,b)=>(a.ticker+'|'+a.resolution).localeCompare(b.ticker+'|'+b.resolution));
    const signature=JSON.stringify(rows);
    if(signature!==demandSignature){demandSignature=signature;demand(rows);}
    const active=[...consumers.values()].filter(c=>c.lease).map(c=>({...c.lease,
      consumer:{id:c.key,generation:c.generation,spec:{name:c.meta.id || c.lease.name,params:c.params}}}));
    const next=JSON.stringify(active);
    if(next!==leaseSignature || active.length && Date.now()-leaseRenewed>=10000){
      leaseSignature=next;leaseRenewed=Date.now();leases(active);
    }
  }
  function scheduleSync(){
    if(disposed || syncQueued)return;
    syncQueued=true;
    // Native data completion follows time-axis acceptance. Observe that scope
    // promptly, while coalescing simultaneous panes into one batch of demands.
    queueMicrotask(()=>{syncQueued=false;void sync();});
  }
  const canonical=params=>JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a],[b])=>a.localeCompare(b))));
  function prune(){
    let total=0,values=0;
    for(const record of shared.values()){total+=record.rows.length;values+=record.values || 0;}
    for(const [key,record] of shared){
      if(total<=400000 && values<=1000000 && shared.size<=24)break;
      if(!record.settled)continue;
      shared.delete(key);total-=record.rows.length;values-=record.values || 0;
    }
  }
  function detach(consumer){drawings?.clear(consumer);if(consumer.retryTimer)clearTimeout(consumer.retryTimer);status(consumer,'removed');release([{id:consumer.key,generation:consumer.generation || 0}]);if(consumer.handle)results.detach(consumer.handle);consumers.delete(consumer.key);}
  function rowsFor(result,page,meta,params,inputs,resolution,ticker){
    const source=new Map(result.series.map(series=>[series.key,new Map(series.values.map(point=>[point.time,point]))]));
    const supertrend=meta.render_profile==='supertrend_pine_v1';
    const swing=meta.render_profile==='swing_sr_v1';
    const nrBreakout=meta.render_profile==='nr_breakout_v1';
    const series=supertrend ? meta.series.filter(series=>series.key!=='direction') :
      nrBreakout ? meta.series.filter(series=>series.key==='range_high') : meta.series;
    const offsets=swing ? {plot1:-params.high_strength,plot3:-params.low_strength} : {};
    const rows=page.bars.map(bar=>{
      const values=series.map(series=>{
        const point=source.get(series.key)?.get(bar.start);
        return point?.break_before && supertrend && ['up','down','fill_reference'].includes(series.key) ? null : point?.value ?? null;
      });
      if(supertrend){
        const [up,down,buy,sell,reference]=values;
        values.splice(0,values.length,up,down,reference,inputs.highlighting ? up : null,inputs.highlighting ? down : null,
          buy,sell,inputs.showsignals ? buy : null,inputs.showsignals ? sell : null);
      }
      // The backend owns exchange trading-date labels. Never infer indexes or
      // regenerate D/W/M chart dates here.
      const time=bar.chart_time ?? identity.chartTime(bar,resolution,ticker);
      return {time,sourceTime:bar.start,values,valid:values.map(Number.isFinite),
        ...(nrBreakout?{drawing:Object.fromEntries(meta.series.map(series=>
          [series.key,source.get(series.key)?.get(bar.start)?.value ?? null]))}:{})};
    });
    return {rows,offsets};
  }
  function scopeIdentity(chart,scope,params,version,binding){
    return {main:chart.symbol(),fixedRevision:binding.revision || 'provider:'+chart.symbol(),
      paramsFingerprint:canonical(params),algorithmVersion:scope.name+':'+(version || '1'),
      inputPolicy:binding.inputPolicy || 'strict_confirmed_v1',
      calculationStart:binding.calculationStart ?? 0,period:scope.resolution};
  }
  async function prepare(consumer,scope){
    const {chart,meta,params,inputs}=consumer;
    drawings?.refresh(consumer);
    const ticker=chart.symbol();
    const binding=identity.binding(chart.symbol(),scope.resolution);
    if(!binding)return;
    if(consumer.retrySnapshot!==(binding.displaySnapshot ?? binding.providerSnapshot)){consumer.displayRetry=null;consumer.failedRetry=null;consumer.retrySnapshot=binding.displaySnapshot ?? binding.providerSnapshot;}
    const nextIdentity=scopeIdentity(chart,scope,params,meta.version,binding);
    // A genuine input revision change withdraws dependent values before recompute.
    // A reset may remove/recreate the coordinator consumer while the adapter
    // retains its rows. A new consumer must also withdraw a corrected binding.
    const corrected=(binding.correctionVersion || 0)!==(consumer.correctionVersion || 0);
    if(!consumer.handle || consumer.generation!==scope.generation ||
      JSON.stringify(consumer.handle.identity)!==JSON.stringify(nextIdentity)){
      if(consumer.handle && JSON.stringify(consumer.handle.identity)!==JSON.stringify(nextIdentity))drawings?.clear(consumer);
      consumer.handle=results.attach(chart,consumer.id,nextIdentity);consumer.sequence=0;
      consumer.generation=scope.generation;
    }
    if(corrected){
      drawings?.clear(consumer);
      const withdrawn=await results.invalidate(consumer.handle,[binding.correctionStart ?? -Number.MAX_VALUE,Number.MAX_VALUE],String(binding.inputRevision ?? binding.tailVersion ?? 0));
      // A native reset can replace the binding while its withdrawal is queued.
      // Do not acknowledge that correction until the current generation really
      // withdrew it; the next sync must retry against the replacement handle.
      if(!withdrawn)return;
      consumer.correctionVersion=binding.correctionVersion;consumer.sequence++;
    }
    // During native reset the engine may already expose a new range while the
    // main study has not accepted it. Reading then wastes a request that the
    // next generation will cancel. Corrections above still withdraw immediately.
    if(!chart.dataReady())return;
    scope=results.scope(chart,consumer.id);if(!scope)return;
    consumer.generation=scope.generation;
    const signature=JSON.stringify([scope.generation,nextIdentity,binding.inputRevision,scope.first,scope.last,scope.count,binding.tailVersion,binding.correctionVersion,binding.displaySnapshot,binding.providerSnapshot,
      inputs.showsignals,inputs.highlighting]);
    consumer.requested=signature;
    if(consumer.failedSignature===signature && consumer.retryAt>Date.now())return;
    if(consumer.accepted===signature)return;
    if(consumer.pending===signature)return;
    consumer.inputRevision=binding.inputRevision;consumer.correctionVersion=binding.correctionVersion;
    consumer.pending=signature;
    const attemptId=crypto.randomUUID();
    // The adapter knows whether native restart retained these results. A
    // consumer's previous scope alone cannot prove that its cache still exists.
    const previous=scope.coverage;
    // Native restarts can retain plot coverage after the drawing consumer was
    // retired. Its empty local projection needs a full snapshot, not just the
    // prefix/tail that the native plot cache is missing.
    const same=!drawings?.needsSnapshot?.(consumer) && previous && previous.identity===JSON.stringify(nextIdentity) &&
      previous.correctionVersion===binding.correctionVersion && previous.inputRevision===binding.inputRevision;
    const prepend=same && previous.first>scope.first && previous.last===scope.last &&
      previous.tailVersion===binding.tailVersion;
    const tail=previous && previous.generation===scope.generation && previous.first===scope.first &&
      previous.last<=scope.last && previous.count<=scope.count && same;
    const requestFirst=tail ? previous.last : scope.first;
    // Provider pages use chart labels; fixed-history readers use source starts.
    // Preserve the backend's actual boundary for NY17 D/W/M instead of guessing.
    const requestBefore=prepend ? previous.sourceFirst ?? previous.first : binding.before ?? scope.last+1;
    const unchangedBinding=()=>{
      const latest=identity.binding(chart.symbol(),scope.resolution);
      return latest && ['revision','inputRevision','tailVersion','correctionVersion','before','displaySnapshot','providerSnapshot','inputPolicy'].every(key=>latest[key]===binding[key]) &&
        (!binding.calculationStart || latest.calculationStart===binding.calculationStart);
    };
    const current=()=>!disposed && chart.symbol()===ticker && chart.resolution()===scope.resolution && consumers.get(consumer.key)===consumer &&
      results.scope(chart,consumer.id)?.generation===scope.generation && consumer.pending===signature && unchangedBinding();
    const key=JSON.stringify([nextIdentity,binding.inputRevision,scope.first,scope.last,scope.count,binding.tailVersion,binding.correctionVersion,binding.displaySnapshot,binding.providerSnapshot,
      inputs.showsignals,inputs.highlighting,requestFirst,requestBefore,consumer.displayRetry]);consumer.cacheKey=key;
    let cached=shared.get(key);
    if(!cached){
      const promise=(async()=>{
        const pages=[],rows=[];let before=requestBefore,covered=false,lease;const deadline=Date.now()+30000;
        for(let partition=0;partition<100;partition++){
          const sharedCurrent=()=>!disposed && [...consumers.values()].some(other=>other.cacheKey===key &&
            results.scope(other.chart,other.id)?.generation===other.generation);
          if(!sharedCurrent())return null;
          if(Date.now()>deadline)throw Error('指标范围读取超时');
          const page=await read(chart.symbol(),scope.resolution,{before,limit:Math.min(2000,scope.count+1),
            indicators:[{name:scope.name,params}],...binding.query,
            _indicatorConsumer:{id:consumer.key,generation:scope.generation,spec:{name:scope.name,params}},
            ...(consumer.displayRetry ? {display_retry:consumer.displayRetry} : {})},sharedCurrent,
            JSON.stringify([binding.revision,binding.calculationStart,binding.inputRevision,binding.tailVersion,binding.correctionVersion,binding.displaySnapshot,binding.providerSnapshot]));
          if(binding.displaySnapshot && page.display_snapshot_id!==binding.displaySnapshot)return null;
          if(binding.providerSnapshot && page.provider_snapshot_id!==binding.providerSnapshot)return null;
          const result=page.indicators?.find(item=>item.name===scope.name && canonical(item.params)===canonical(params));
          if(!result)throw Error('Python 指标结果未返回');
          // Fixed-result progress is keyed by run_id/id, not name. Different
          // parameters of one algorithm can have independent pending runs.
          const progress=result.calculation ||
            (page.indicators.length===1 ? page.indicator_progress?.find(item=>item.id===(result.id || scope.name)) : undefined);
          if(progress?.run_id)lease={name:scope.name,run_id:progress.run_id,
            snapshot_id:binding.displaySnapshot || null,start:page.bars[0]?.start ?? 0,end:page.bars.at(-1)?.end ?? 0};
          const legacyCovered=progress?.visible_complete===undefined && progress?.display_status==='complete' &&
            result.series.every(series=>{const times=new Set(series.values.map(point=>point.time));return page.bars.every(bar=>times.has(bar.start));});
          if(progress && (progress.display_status && progress.display_status!=='complete' ||
            progress.status!=='complete' && !progress.visible_complete && !legacyCovered))return {pending:true,lease};
          if(page.input_revision!==undefined && binding.inputRevision!==undefined && page.input_revision!==binding.inputRevision)return null;
          rows.push(...rowsFor(result,page,meta,params,inputs,scope.resolution,chart.symbol()).rows);
          // Keep only result identity/revision/presentation in the shared cache.
          // Raw bars and plot payloads would duplicate the normalized rows.
          const {bars,indicators,...metadata}=page;
          pages.push({calculation:progress,page:{...metadata,presentation:result.presentation,
            ...(result.presentation ? {bars:bars.map(bar=>({start:bar.start,chart_time:bar.chart_time}))} : {})}});
          if(!page.bars.length || (page.bars[0].chart_time ?? identity.chartTime(page.bars[0],scope.resolution,chart.symbol()))<=requestFirst || page.has_more===false){covered=true;break;}
          if(!((page.next_before ?? page.bars[0]?.start)<before))throw Error('指标范围分页未推进');
          before=page.next_before ?? page.bars[0]?.start;
        }
        if(!covered)throw Error('指标范围超出读取容量');
        const unique=[...new Map(rows.filter(row=>row.time>=requestFirst).map(row=>[row.time,row])).values()].sort((a,b)=>a.time-b.time);
        if(unique.length>200000)throw Error('指标范围超出缓存容量');
        return {rows:unique,pages,lease};
      })();
      cached={promise,rows:[]};shared.set(key,cached);
      promise.then(value=>{cached.settled=true;if(value && !value.pending){cached.rows=value.rows;cached.values=value.rows.reduce((n,row)=>n+row.values.length+Object.keys(row.drawing || {}).length,0);}else shared.delete(key);},()=>{cached.settled=true;shared.delete(key);});
    }
    status(consumer,'preparing');
    try {
      const batch=await cached.promise;
      if(!current() || !batch)return;
      consumer.lease=batch.lease;
      if(batch.pending){
        if(consumer.waitSignature!==signature){consumer.waitSignature=signature;consumer.waitStarted=Date.now();consumer.waitAttempts=0;}
        if(Date.now()-consumer.waitStarted>=30000){const error=Error('指标计算等待超过30秒，请重试');error.code='INDICATOR_TIMEOUT';throw error;}
        // A committed job wakes the server worker immediately. Observe its
        // bounded pages promptly, then back off for genuinely long replays.
        const delay=Math.min(1000,50*2**Math.min(5,consumer.waitAttempts++));
        consumer.failedSignature=signature;consumer.retryAt=Date.now()+delay;
        if(consumer.retryTimer)clearTimeout(consumer.retryTimer);
        consumer.retryTimer=setTimeout(()=>{consumer.retryTimer=null;scheduleSync();},delay);
        return;
      }
      const page=batch.pages[0]?.page;
      const revisionOf=item=>String(item?.input_revision ?? item?.cache_revision ?? item?.revision ?? item?.history_revision ?? '');
      if(batch.pages.some(({page:item})=>revisionOf(item)!==revisionOf(page))){shared.delete(key);return;}
      // Managed history fingerprints/publication counters are not the accepted
      // tail version. Keep apply and invalidate in the same numeric domain.
      const revision=String(page?.input_revision ?? page?.cache_revision ?? page?.revision ?? binding.inputRevision ?? binding.tailVersion ?? 0);
      identity.remember?.(chart.symbol(),scope.resolution,page);
      const origin=page?.calculation_origin ?? page?.origin ?? binding.calculationStart;
      if(Number.isFinite(origin) && nextIdentity.calculationStart!==origin){
        nextIdentity.calculationStart=origin;consumer.handle=results.attach(chart,consumer.id,nextIdentity);consumer.sequence=0;consumer.generation=consumer.handle.generation;
        // The accepted first read established the real origin. This handle is
        // the same consumer/input observation, now fenced by its new generation.
        scope={...scope,generation:consumer.handle.generation};
      }
      const offsets=meta.render_profile==='swing_sr_v1'?{plot1:-params.high_strength,plot3:-params.low_strength}:{};
      const coverage={first:scope.first,last:scope.last,count:scope.count,identity:JSON.stringify(nextIdentity),
        sourceFirst:tail ? previous.sourceFirst : batch.rows.find(row=>row.time>=scope.first)?.sourceTime,
        correctionVersion:binding.correctionVersion,inputRevision:binding.inputRevision,tailVersion:binding.tailVersion};
      const accepted=await results.applyBatch(consumer.handle,{identity:consumer.handle.identity,
        current,displaySnapshot:binding.displaySnapshot ?? binding.providerSnapshot,
        executionEvidence:batch.pages.map(item=>item.calculation).filter(Boolean),
        generation:consumer.handle.generation,sequence:++consumer.sequence,inputRevision:revision,
        kind:prepend?'prepend':tail?'append':'snapshot',rows:batch.rows,offsets,coverage});
      if(accepted){consumer.acceptedScope={...coverage,generation:consumer.handle.generation};
        drawings?.update(consumer,{kind:prepend?'prepend':tail?'append':'snapshot',rows:batch.rows,identity:nextIdentity});
        consumer.accepted=JSON.stringify([consumer.handle.generation,nextIdentity,binding.inputRevision,scope.first,scope.last,scope.count,binding.tailVersion,binding.correctionVersion,binding.displaySnapshot,binding.providerSnapshot,inputs.showsignals,inputs.highlighting]);
        consumer.requested=consumer.accepted;
        const evidence=batch.pages.map(item=>item.calculation).filter(Boolean);
        const quality={coverage:evidence.some(item=>item.input_quality?.coverage==='unverified')?'unverified':'verified',
          provisional:evidence.some(item=>item.input_quality?.provisional),
          reason:evidence[0]?.reason_code || '',
          sampleSize:evidence[0]?.input_quality?.sample_size,requiredSamples:evidence[0]?.input_quality?.required_samples};
        const state=evidence.some(item=>item.value_status==='unavailable') ? 'unavailable' :
          evidence.length && evidence.every(item=>item.value_status==='insufficient_input') ? 'insufficient_input' : 'ready';
        consumer.failures=0;consumer.retryAt=0;consumer.waitSignature=null;consumer.displayRetry=null;consumer.failedRetry=null;status(consumer,state,null,quality);recovered(consumer);
        for(const {page} of batch.pages)presentation(chart.symbol(),scope.resolution,{...page,indicators:[{name:scope.name,params,presentation:page.presentation}]});}
    }catch(error){if(current()){
      consumer.failedSignature=signature;
      if(error.code==='DISPLAY_SNAPSHOT_EXPIRED' && recover){
        // A replacement price read owns its new credential. Never retry the
        // indicator by silently substituting a newer snapshot under old prices.
        consumer.retryAt=Infinity;
        try {
          await recover(chart.symbol(),scope.resolution,binding.displaySnapshot ?? binding.providerSnapshot,error);
          consumer.retryAt=0;
        } catch(recoveryError) {
          if(current()){status(consumer,'error',recoveryError);report(recoveryError,consumer);occurrence(recoveryError,consumer,attemptId);}
        }
        return;
      }
      consumer.failedRetry=error.display_retry;
      consumer.failures=(consumer.failures || 0)+1;
      consumer.retryAt=['DISPLAY_SUFFIX_CAPACITY_EXCEEDED','DISPLAY_REPLAY_FAILED','INDICATOR_TIMEOUT'].includes(error.code) || consumer.failures>=3 ?
        Infinity:Date.now()+1000*2**consumer.failures;
      status(consumer,'error',error);report(error,consumer);
      if(consumer.retryAt===Infinity)occurrence(error,consumer,attemptId);
    }}
    finally{if(consumer.pending===signature)consumer.pending=null;prune();}
  }
  async function sync(){
    if(disposed)return;
    {
      const live=new Set(),liveCharts=new Set(),work=[];
      for(let index=0;index<widget.chartsCount();index++){
        const chart=widget.chart(index);
        const owner=chart._chartWidget || chart;liveCharts.add(owner);
        if(!rangeEvents.has(owner)){
          const event=chart.onDataLoaded();event.subscribe(null,scheduleSync);
          rangeEvents.set(owner,()=>event.unsubscribe(null,scheduleSync));
        }
        for(const study of chart.getAllStudies()){
          const scope=results.scope(chart,study.id);if(!scope)continue;
          const meta=catalog[scope.name];if(!meta)continue;
          const api=chart.getStudyById(study.id);if(api.isVisible && !api.isVisible())continue;
          const inputs=Object.fromEntries(api.getInputValues().map(item=>[item.id,item.value]));
          const params=meta.render_profile==='supertrend_pine_v1' ? {period:inputs.period,source:inputs.source,
            multiplier:inputs.multiplier,atr_method:inputs.changeATR ? 'wilder' : 'sma'} :
            Object.fromEntries(Object.keys(meta.params).map(key=>[key,inputs[key]]));
          if(!charts.has(owner))charts.set(owner,++chartSequence);
          const key=charts.get(owner)+'|'+study.id;live.add(key);
          let consumer=consumers.get(key);
          if(!consumer){consumer={key,id:study.id,chart,index,meta,params,inputs,sequence:0};consumers.set(key,consumer);}
          else Object.assign(consumer,{chart,index,meta,params,inputs});
          const operation={ticker:chart.symbol(),resolution:chart.resolution()};
          operation.promise=prepare(consumer,scope).catch(error=>report(error,consumer));
          operations.add(operation);
          operation.promise.finally(()=>operations.delete(operation));
          work.push(operation.promise);
        }
      }
      for(const [owner,unsubscribe] of rangeEvents)if(!liveCharts.has(owner)){
        unsubscribe();rangeEvents.delete(owner);
      }
      for(const consumer of consumers.values())if(!live.has(consumer.key))detach(consumer);
      publishDemand();
      await Promise.allSettled(work);
      if(!disposed)publishDemand();
    }
  }
  async function settle(matches,current=()=>true){
    // A simultaneous sync may have deduplicated against an older pending read.
    // Await that actual operation rather than its fast no-op replacement.
    while(!disposed && current()){
      // Start/retry the accepted credential, including a pending background
      // suffix. The display queue supplies the cancellation/deadline predicate.
      void sync();
      const active=[...operations].filter(op=>matches(op.ticker,op.resolution));
      await Promise.allSettled(active.map(op=>op.promise));
      const relevant=[...consumers.values()].filter(c=>matches(c.chart.symbol(),c.chart.resolution()));
      if(relevant.every(c=>c.chart.dataReady() && c.accepted && c.accepted===c.requested))return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  const stopNativeEvents=results.subscribe?.(scheduleSync);
  const studyEvents=['study_event','study_properties_changed','chart_loaded'];
  for(const event of studyEvents)widget.subscribe?.(event,scheduleSync);
  timer=setInterval(()=>void sync(),500);
  return {sync,settle,retry(index){for(const c of consumers.values())if(c.index===index){c.retryAt=0;c.failures=0;c.waitSignature=null;c.accepted=null;shared.delete(c.cacheKey);c.displayRetry=c.failedRetry;}return sync();},dispose(){disposed=true;clearInterval(timer);stopNativeEvents?.();for(const event of studyEvents)widget.unsubscribe?.(event,scheduleSync);for(const unsubscribe of rangeEvents.values())unsubscribe();rangeEvents.clear();for(const consumer of consumers.values())detach(consumer);shared.clear();publishDemand();},
    diagnostics:()=>({consumers:consumers.size,shared:shared.size,rows:[...shared.values()].reduce((n,r)=>n+r.rows.length,0)})};
}

// Coalesce independent studies over the same input page. Cancellation belongs
// to each consumer; one deletion must not abort the remaining shared read.
function chartIndicatorReadBatch(read) {
  const queued=new Map(),inFlight=new Map();
  return (ticker,resolution,args,current,inputVersion=null)=>new Promise((resolve,reject)=>{
    const {indicators,_indicatorConsumer,...query}=args,key=JSON.stringify([ticker,resolution,query,inputVersion]);
    let group=queued.get(key);
    // Native pagination can restart a study before its accepted source page
    // returns. A replacement needing the same dispatched specs joins that
    // request, so removing the old generation does not abort valid new demand.
    if(!group)group=[...(inFlight.get(key) || [])].find(candidate=>
      indicators.every(spec=>candidate.specKeys.has(JSON.stringify(spec))));
    if(!group){
      group={ticker,resolution,query,consumers:[]};queued.set(key,group);
      queueMicrotask(async()=>{
        queued.delete(key);
        const alive=()=>group.consumers.some(consumer=>consumer.current());
        const specs=[...new Map(group.consumers.filter(c=>c.current()).flatMap(c=>c.indicators)
          .map(spec=>[JSON.stringify(spec),spec])).values()];
        group.specKeys=new Set(specs.map(spec=>JSON.stringify(spec)));
        let running=inFlight.get(key);
        if(!running){running=new Set();inFlight.set(key,running);}
        running.add(group);
        try {
          if(!alive())throw Object.assign(Error('指标读取已取消'),{code:'HISTORY_CANCELLED'});
          let page;
          for(let offset=0;offset<specs.length;offset+=12){
            if(!alive())throw Object.assign(Error('指标读取已取消'),{code:'HISTORY_CANCELLED'});
            const demands=group.consumers.filter(c=>c.current() && c.demand).map(c=>c.demand);
            const next=await read(ticker,resolution,{...query,indicators:specs.slice(offset,offset+12),
              ...(demands.length ? {indicator_consumers:demands} : {})},alive);
            if(!page)page=next;
            else {
              const revision=item=>JSON.stringify([item.input_revision,item.cache_revision,item.revision,item.calculation_origin,item.origin,item.display_snapshot_id,item.provider_snapshot_id]);
              if(revision(page)!==revision(next))throw Error('批量指标输入在读取期间改变，请重试');
              page={...page,indicators:[...(page.indicators || []),...(next.indicators || [])],
                indicator_progress:[...(page.indicator_progress || []),...(next.indicator_progress || [])]};
            }
          }
          for(const consumer of group.consumers)consumer.current()?consumer.resolve(page):
            consumer.reject(Object.assign(Error('指标读取已取消'),{code:'HISTORY_CANCELLED'}));
        }catch(error){for(const consumer of group.consumers)consumer.reject(error);}
        finally{running.delete(group);if(!running.size)inFlight.delete(key);}
      });
    }
    group.consumers.push({indicators,current,resolve,reject,demand:_indicatorConsumer});
  });
}
