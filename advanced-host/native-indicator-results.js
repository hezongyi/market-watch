/* Python result batches own these studies; the native engine owns their views.
 * Private v31 structures are accessed only here, behind the pinned build hook. */
const MWNativeIndicatorResultsAdapter = (() => {
  const expected='6b804c486857f27920cf761aa7eb6e29d9bb6362';
  const sessions=new WeakMap();
  const handles=new WeakMap();
  const studyBindings=new WeakMap();
  const listeners=new Set();
  let catalog={},enabled=false,generation=0,cells=0;
  const fingerprint=value=>JSON.stringify(value);
  const numericRevision=value=>/^\d+$/.test(String(value)) ? BigInt(value) : null;
  function entry(engine,session,source){return sessions.get(engine)?.get(session+'|'+source);}
  function current(binding){return binding.alive && !binding.stopped && entry(binding.engine,binding.session,binding.source)===binding &&
    binding.engine._studiesCache[binding.session]?.[binding.source]?.turnaround===binding.turnaround;}
  function configure(next,{enable=false}={}){
    if(enable && !String(TradingView.version()).includes(expected))throw Error('指标结果通道版本尚未适配');
    catalog=next;enabled=enable;
  }
  function start(engine,symbol,resolution,body,session,source,turnaround,parent,inputs){
    const item=engine._studiesCache[session]?.[source];
    const match=/^MWPython(.+)@market-watch-1$/.exec(item?.metainfo?.id || '');
    if(!enabled || !match || !catalog[match[1]])return false;
    if(typeof engine._timeScales[session]?.fillIndexesInRows!=='function' ||
      typeof engine._chartApiMessagerProvider?.getChartApiMessager!=='function')
      throw Error('原生指标结果契约不兼容');
    let records=sessions.get(engine);
    if(!records){records=new Map();sessions.set(engine,records);}
    const previous=entry(engine,session,source);
    // Native history extension may restart the same study. Keep only results
    // with identical source, parent and resolution. Parameter changes retain
    // the old display identity, never accept it as a new calculation result.
    // A new generation still fences every old handle/queued batch.
    const retained=previous && previous.alive && previous.parent===parent && previous.resolution===resolution &&
      previous.name===match[1] && fingerprint(previous.symbol)===fingerprint(symbol)
      ? {rows:new Map(previous.rows),identity:previous.identity,study:previous.study,chart:previous.chart,revision:previous.revision,
          offsets:previous.offsets,cells:previous.cells || 0,coverage:previous.coverage,
          transition:previous.transition,displayIdentity:previous.displayIdentity || previous.identity} : null;
    if(previous)detach(previous);
    const binding={engine,session,source,parent,turnaround,symbol,resolution,name:match[1],inputs:{...inputs},
      generation:++generation,alive:true,sequence:0,revision:null,rows:new Map(),queue:Promise.resolve()};
    if(retained){Object.assign(binding,retained);cells+=retained.cells;}
    if(retained?.study)studyBindings.set(retained.study,binding);
    records.set(session+'|'+source,binding);
    // All native restarts enter this hook again; no Pine or MWPY writer starts.
    item.engine={stop:()=>{
      binding.stopped=true;
      // A synchronous native restart gets a chance to transfer this cache.
      // A genuine deletion releases it at the next microtask, even if the
      // coordinator has already been disposed.
      queueMicrotask(()=>{if(entry(engine,session,source)===binding)detach(binding);});
    },isStarted:()=>binding.alive && !binding.stopped};
    item.completed=false;
    engine._chartApiMessagerProvider.getChartApiMessager(session).onStudyLoading(source,turnaround);
    if(retained?.study && retained.rows.size && binding.chart && binding.identity?.main===binding.chart.symbol() &&
      engine._getSeriesData(session,parent)?.length){
      binding.queue=binding.queue.then(async()=>{
        await binding.study._ongoingDataUpdate;
        if(current(binding)){
          commit(binding,binding.rows,binding.offsets);
          await binding.study._ongoingDataUpdate;
        }
      });
      binding.queue=binding.queue.catch(()=>{});
    }
    // Native readiness can follow the public study event. Wake consumers at
    // this actual seam instead of waiting for their safety poll.
    queueMicrotask(()=>{for(const listener of listeners)listener();});
    return true;
  }
  function attach(chart,id,identity){
    const study=chart._chartWidget.model().model().dataSourceForId(id),api=study?._chartApi;
    const engine=api?.chartApi?.()._studyEngine,session=api?.sessionId?.(),source=study?.sourceId?.();
    const binding=engine && entry(engine,session,source);
    if(!binding || !current(binding))throw Error('指标尚未进入外部结果模式');
    if(binding.study && binding.study!==study)throw Error('指标实例绑定冲突');
    if(!identity || !identity.main || !identity.fixedRevision || !identity.paramsFingerprint ||
      !identity.algorithmVersion || !Number.isFinite(identity.calculationStart))throw Error('指标结果身份不完整');
    if(binding.identity && fingerprint(binding.identity)!==fingerprint(identity)){
      // A new calculation origin/identity fences all queued handles. The engine
      // itself is already in external mode, so no second writer is introduced.
      const old=binding.displayIdentity || binding.identity;
      const sameInput=['main','fixedRevision','algorithmVersion','calculationStart','period','inputPolicy'].every(key=>old[key]===identity[key]);
      binding.generation=++generation;binding.sequence=0;
      if(sameInput && binding.rows.size){
        binding.transition={identity:old,params:JSON.parse(old.paramsFingerprint)};
      }else{
        // A revision/origin switch cannot leave old indicators over new prices.
        cells-=binding.cells || 0;binding.cells=0;binding.rows.clear();binding.mapping=null;
        binding.revision=null;binding.transition=null;binding.displayIdentity=null;
        binding.queue=binding.queue.then(async()=>{
          await study._ongoingDataUpdate;
          if(current(binding)){commit(binding,new Map());await study._ongoingDataUpdate;}
        }).catch(()=>{});
      }
      binding.coverage=null;
    }
    binding.identity=Object.freeze({...identity});binding.study=study;
    binding.chart=chart;studyBindings.set(study,binding);
    if(!study._mwExternalResults){
      const clear=study.clearData;
      if(typeof clear!=='function')throw Error('原生指标清理契约不兼容');
      study.clearData=function(...args){
        const owner=studyBindings.get(this);
        const same=owner?.alive && owner.chart && owner.rows.size && owner.identity?.main===owner.chart.symbol() &&
          owner.resolution===owner.chart.resolution();
        if(same)return;
        return clear.apply(this,args);
      };
      const original=study._onDataUnpacked;
      study._onDataUnpacked=function(rows,indexes,turn,nonseries){
        // Runs inside the native serialized update, immediately before merge.
        // An empty snapshot and a shortened tail therefore really delete rows.
        if(!this._isDestroyed){
          if(nonseries?.data?.mwResultsReplace)this.data().remove(-Infinity);
          else if(nonseries?.data?.mwResultsRemoveFrom!==undefined)this.data().remove(nonseries.data.mwResultsRemoveFrom);
        }
        return original.call(this,rows,indexes,turn,nonseries);
      };
      study._mwExternalResults=true;
    }
    const handle=Object.freeze({generation:binding.generation,identity:binding.identity});
    handles.set(handle,binding);return handle;
  }
  function scope(chart,id){
    const study=chart._chartWidget.model().model().dataSourceForId(id),api=study?._chartApi;
    const engine=api?.chartApi?.()._studyEngine,session=api?.sessionId?.(),source=study?.sourceId?.();
    const binding=engine && entry(engine,session,source);
    if(!binding || !current(binding))return null;
    const rows=engine._getSeriesData(session,binding.parent) || [];
    if(!rows.length)return null;
    const mapping=JSON.stringify([rows[0]?.index,rows[0]?.value[0]]);
    if(binding.rows.size && binding.study && binding.identity?.main===chart.symbol() &&
      binding.mapping!==mapping && binding.projecting!==mapping){
      binding.projecting=mapping;
      binding.queue=binding.queue.then(async()=>{
        await binding.study._ongoingDataUpdate;
        if(current(binding)){
          commit(binding,binding.rows,binding.offsets);
          await binding.study._ongoingDataUpdate;
        }
      }).finally(()=>{if(binding.projecting===mapping)binding.projecting=null;});
      binding.queue=binding.queue.catch(()=>{});
    }
    return {generation:binding.generation,name:binding.name,resolution:binding.resolution,
      first:Math.round(rows[0].value[0]*1000),last:Math.round(rows.at(-1).value[0]*1000),count:rows.length,
      coverage:binding.coverage ? {...binding.coverage,generation:binding.generation} : null,
      transition:binding.transition || null};
  }
  function validate(handle,batch){
    const binding=handles.get(handle);
    if(!binding)return false;
    if(!current(binding) || handle.generation!==binding.generation)return false;
    if(batch.generation!==handle.generation || batch.sequence<=binding.sequence)return false;
    if(fingerprint(batch.identity)!==fingerprint(handle.identity))return false;
    if(batch.current && !batch.current())return false;
    const next=numericRevision(batch.inputRevision),old=numericRevision(binding.revision);
    if(next===null || old!==null && next<old)return false;
    if(!Number.isSafeInteger(batch.sequence) || !['snapshot','prepend','append','replaceRange'].includes(batch.kind))
      throw Error('无效指标结果批次');
    if(!Array.isArray(batch.rows) || batch.rows.length>200000)throw Error('指标结果批次超出容量');
    const plots=binding.engine._studiesCache[binding.session][binding.source].metainfo.plots.length;
    let previous=-Infinity;
    for(const row of batch.rows){
      if(!Number.isFinite(row.time) || row.time<=previous || !Array.isArray(row.values) ||
        !Array.isArray(row.valid) || row.values.length!==plots || row.valid.length!==plots ||
        row.valid.some((valid,i)=>typeof valid!=='boolean' || valid && !Number.isFinite(row.values[i])))
        throw Error('无效指标结果行');
      previous=row.time;
    }
    if(batch.kind==='replaceRange' && (!Array.isArray(batch.range) || batch.range.length!==2 ||
      !batch.range.every(Number.isFinite) || batch.range[0]>=batch.range[1] ||
      batch.rows.some(row=>row.time<batch.range[0] || row.time>=batch.range[1])))throw Error('无效指标替换区间');
    return true;
  }
  function commit(binding,rows,offsets={}){
    const {engine,session,source,turnaround}=binding;
    const main=engine._getSeriesData(session,binding.parent) || [];
    const times=new Set(main.map(row=>Math.round(row.value[0]*1000)));
    const mapping=JSON.stringify([main[0]?.index,main[0]?.value[0]]);
    // A prepend or native remapping needs a complete time-to-index projection.
    // Ordinary tail updates only merge changed plots. Deletions truncate from
    // the earliest affected native index and replay the retained tail atomically.
    let removeFrom,cutoff=-Infinity;
    if(binding.mapping!==mapping)removeFrom=-Infinity;
    else {
      for(const time of binding.rows.keys())if(times.has(time) && !rows.has(time))cutoff=Math.min(cutoff===-Infinity?time:cutoff,time);
      if(cutoff!==-Infinity){
        const marker=[{index:0,value:[cutoff/1000]}];
        engine._timeScales[session].fillIndexesInRows(marker);removeFrom=marker[0].index;
      }
    }
    const equal=(a,b)=>a && a.valid.every((v,i)=>v===b.valid[i] && (!v || a.values[i]===b.values[i]));
    const nativeRows=[...rows.values()].filter(row=>times.has(row.time) &&
      (removeFrom===-Infinity || cutoff!==-Infinity && row.time>=cutoff || !equal(binding.rows.get(row.time),row)))
      .sort((a,b)=>a.time-b.time)
      .map(row=>({index:0,value:[row.time/1000,...row.values.map((value,i)=>row.valid[i]?value:null)]}));
    engine._timeScales[session].fillIndexesInRows(nativeRows);
    const messenger=engine._chartApiMessagerProvider.getChartApiMessager(session);
    messenger.onDataUpdate(source,turnaround,nativeRows,{data:{offsets,data:{
      ...(removeFrom===-Infinity?{mwResultsReplace:true}:removeFrom!==undefined?{mwResultsRemoveFrom:removeFrom}:{}),
    }},indexes:[]});
    const item=engine._studiesCache[session][source];item.completed=true;
    item.firstLoadedTimeMs=rows.size?[...rows.keys()].reduce((first,time)=>Math.min(first,time),Infinity):null;
    engine._setEndOfData(session,source,turnaround,true);
    messenger.onStudyCompleted(source,turnaround);engine._updateTimeScaleState(session);
    binding.mapping=mapping;
  }
  function applyBatch(handle,batch){
    const binding=handles.get(handle);
    if(!binding)return Promise.resolve(false);
    binding.queue=binding.queue.then(async()=>{
      if(!validate(handle,batch))return false;
      const rows=batch.kind==='snapshot' ? new Map() : new Map(binding.rows);
      if(batch.kind==='replaceRange')for(const time of rows.keys())if(time>=batch.range[0] && time<batch.range[1])rows.delete(time);
      for(const row of batch.rows)rows.set(row.time,{time:row.time,values:[...row.values],valid:[...row.valid]});
      const count=rows.size*binding.engine._studiesCache[binding.session][binding.source].metainfo.plots.length;
      if(rows.size>200000 || cells-(binding.cells || 0)+count>2000000)throw Error('指标结果缓存超出容量');
      // Native updates are serialized too. Validate once more after waiting.
      await binding.study._ongoingDataUpdate;
      if(!validate(handle,batch))return false;
      if(cells-(binding.cells || 0)+count>2000000)throw Error('指标结果缓存超出容量');
      commit(binding,rows,batch.offsets);
      cells+=count-(binding.cells || 0);binding.cells=count;
      binding.rows=rows;binding.sequence=batch.sequence;binding.revision=batch.inputRevision;
      if(batch.kind==='snapshot'){
        binding.transition=null;binding.displayIdentity=binding.identity;
      }
      if(!rows.size){binding.transition=null;binding.displayIdentity=null;}
      binding.coverage=batch.coverage ? {...batch.coverage} : null;
      binding.offsets=batch.offsets || {};
      await binding.study._ongoingDataUpdate;
      return true;
    });
    const result=binding.queue;binding.queue=result.catch(()=>{});return result;
  }
  function invalidate(handle,range,inputRevision){
    const binding=handles.get(handle);
    if(!binding)return Promise.resolve(false);
    return applyBatch(handle,{identity:handle.identity,generation:handle.generation,kind:'replaceRange',range,
      sequence:binding.sequence+1,inputRevision,rows:[]});
  }
  function detach(target){
    const owner=handles.get(target),binding=owner || target;
    if(!binding?.alive)return;
    if(owner && target.generation!==binding.generation)return;
    cells-=binding.cells || 0;binding.cells=0;binding.rows.clear();
    binding.coverage=null;
    if(owner){
      binding.generation=++generation;binding.identity=null;binding.sequence=0;
      binding.revision=null;binding.mapping=null;return;
    }
    binding.alive=false;
    const records=sessions.get(binding.engine);
    if(records?.get(binding.session+'|'+binding.source)===binding)records.delete(binding.session+'|'+binding.source);
  }
  return {configure,start,attach,scope,applyBatch,invalidate,detach,
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    enabled:name=>enabled && !!catalog[name]};
})();
globalThis.MWNativeIndicatorResults=MWNativeIndicatorResultsAdapter;
