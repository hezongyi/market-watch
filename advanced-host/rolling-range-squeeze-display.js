/* Python owns the bar-index geometry, signal state, label text and Pine GC.
 * These owner-bound drawings are disposable and never saved as user drawings.
 */
function squeezeSnapshotStore() {
  return swingSnapshotStore({name:'ROLLING_RANGE_SQUEEZE',profile:'rolling_range_squeeze_v1',
    origin:'calculation_origin',keyOf:(symbol,resolution,p)=> {
      if(typeof MWSeries!=='undefined') {
        const id=MWSeries.decode(symbol);symbol=MWSeries.encode(id.symbol,id.series_kind);
      }
      return JSON.stringify([symbol,resolution,p.k,p.lookback,p.low_pct,p.confirm_on_close]);
    }});
}

function chartSqueezeDisplay(widget,store,{identity,report=()=>{}}) {
  const bindings=new Map();
  let disposed=false;
  function remove(binding) {
    binding.alive=false;
    for(const id of binding.shapes.values()) {
      try {binding.chart.removeEntity(id,{disableUndo:true});} catch { /* Owner already gone. */ }
    }
    binding.shapes.clear();
  }
  function reset() {for(const b of bindings.values())remove(b);bindings.clear();store.clear();}
  function loadedRange(chart) {
    const bars=chart._chartWidget.model().model().mainSeries().bars();
    const first=bars.firstIndex(),last=bars.lastIndex();
    if(first==null || last==null)return null;
    const from=chart._convertIndexToPublicTime(first)*1000;
    const to=chart._convertIndexToPublicTime(last)*1000;
    return Number.isFinite(from) && Number.isFinite(to)?{from,to}:null;
  }
  async function render(binding,p,input,signature,range) {
    if(binding.pending)return;
    binding.pending=true;
    try {
      const requested=new Map();
      for(const box of p.boxes) {
        // The native tool snaps unloaded dates to the first/last price bar.
        // Keep the full snapshot and project only onto currently loaded bars.
        if(box.right_chart_time<range.from || box.left_chart_time>range.to)continue;
        const first=box.kind==='first';
        requested.set('box:'+box.id,{points:[
          {time:Math.max(box.left_chart_time,range.from)/1000,price:box.top},
          {time:Math.min(box.right_chart_time,range.to)/1000,price:box.bottom}],
          shape:'rectangle',overrides:{color:input[first?'first_border_color':'next_border_color'],
            backgroundColor:input[first?'first_fill_color':'next_fill_color'],
            linewidth:2,fillBackground:true,transparency:0,extendLeft:false,extendRight:false}});
      }
      for(const label of p.labels) {
        if(label.chart_time<range.from || label.chart_time>range.to)continue;
        requested.set('label:'+label.time,{
        points:[{time:label.chart_time/1000,price:label.price}],shape:'balloon',text:label.text,
        overrides:{color:input.label_text_color,backgroundColor:input.label_bg_color,
          borderColor:'rgba(0,0,0,0)',fontsize:12,transparency:0}});
      }
      for(const [key,id] of binding.shapes) if(!requested.has(key)) {
        binding.chart.removeEntity(id,{disableUndo:true});binding.shapes.delete(key);
      }
      for(const [key,item] of requested) {
        if(!binding.alive || disposed)return;
        const id=binding.shapes.get(key);
        if(id) {
          const shape=binding.chart.getShapeById(id);
          shape.setPoints(item.points);shape.setProperties({...item.overrides,...(item.text?{text:item.text}:{})});
        } else {
          const created=await binding.chart.createMultipointShape(item.points,{
            shape:item.shape,text:item.text,ownerStudyId:binding.id,
            lock:true,disableSelection:true,disableSave:true,disableUndo:true,showInObjectsTree:false,
            overrides:item.overrides});
          if(!binding.alive || disposed) {
            binding.chart.removeEntity(created,{disableUndo:true});return;
          }
          binding.shapes.set(key,created);
        }
      }
      // Retained boxes are in Pine creation order; green is recreated last on
      // every extension. Reapply that order even when native IDs are reused.
      for(const key of requested.keys())binding.chart.getShapeById(binding.shapes.get(key)).bringToFront();
      if(binding.smaColor!==input.sma_color) {
        binding.study.applyOverrides({'SMA(Close, K).color':input.sma_color});
        binding.smaColor=input.sma_color;
      }
      binding.signature=signature;binding.failures=0;
    } catch(error) {if(binding.alive && ++binding.failures===1)report(error);}
    finally {binding.pending=false;}
  }
  function refresh() {
    if(disposed)return;
    const live=new Set();
    for(let index=0;index<widget.chartsCount();index++) {
      const chart=widget.chart(index);
      if(!chart.dataReady())continue;
      for(const item of chart.getAllStudies()) {
        if(!['守望 Python ROLLING_RANGE_SQUEEZE','Rolling Range Squeeze'].includes(item.name))continue;
        const key=index+':'+item.id,study=chart.getStudyById(item.id);
        const input=Object.fromEntries(study.getInputValues().map(i=>[i.id,i.value]));
        const params=Object.fromEntries(['k','lookback','low_pct','confirm_on_close'].map(k=>[k,input[k]]));
        const fingerprint=JSON.stringify([chart.symbol(),chart.resolution(),params]);
        let binding=bindings.get(key);
        if(binding && (binding.chart!==chart || fingerprint!==binding.fingerprint || !study.isVisible())) {
          remove(binding);bindings.delete(key);binding=null;
        }
        if(!study.isVisible())continue;
        live.add(key);
        if(!binding) {
          binding={chart,study,id:item.id,alive:true,shapes:new Map(),fingerprint,failures:0};
          bindings.set(key,binding);
        }
        const record=store.get(identity(chart.symbol()),chart.resolution(),params);
        if(!record)continue;
        const range=loadedRange(chart);
        if(!range)continue;
        const p=record.presentation,signature=JSON.stringify([p.boxes,p.labels,input,range]);
        if(signature!==binding.signature)void render(binding,p,input,signature,range);
      }
    }
    for(const [key,b] of bindings)if(!live.has(key)){remove(b);bindings.delete(key);}
  }
  const refreshSafe=()=>{try{refresh();}catch(error){report(error);}};
  const events=['study_event','study_properties_changed','layout_changed'];
  for(const event of events)widget.subscribe(event,refreshSafe);
  widget.subscribe('chart_load_requested',reset);
  const timer=setInterval(refreshSafe,250);
  return {refresh:refreshSafe,reset,dispose(){disposed=true;clearInterval(timer);reset();
    for(const event of events)widget.unsubscribe(event,refreshSafe);
    widget.unsubscribe('chart_load_requested',reset);}};
}
