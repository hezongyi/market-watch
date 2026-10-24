/* LuxAlgo NR4/NR7 adaptation © LuxAlgo, CC BY-NC-SA 4.0.
 * Render backend coordinates only. Drawings are disposable and never saved.
 */
function nrBreakoutObjects(rows, inputs) {
  const ranges=new Map(),boxes=new Map(),signals=[],periods=new Set();
  for(const row of rows) {
    const d=row.drawing;
    if(!d)continue;
    if(Number.isFinite(d.period_start))periods.add(d.period_start);
    if(Number.isFinite(d.range_start))ranges.set(d.range_start,d);
    if(Number.isFinite(d.pattern_start))boxes.set(d.pattern_start,d);
    for(const side of ['up','down'])if(Number.isFinite(d[side+'_signal']))
      signals.push({side,time:row.time,price:d[side+'_signal']});
  }
  const objects=new Map(),point=(time,price)=>({time:time/1000,price});
  // Pine's 500 boxes include the current invisible box and all non-NR periods.
  const firstPeriod=periods.size>=500?[...periods].sort((a,b)=>a-b).slice(-500)[0]:-Infinity;
  for(const [start,d] of boxes)if(start>=firstPeriod) {
    const color=inputs[d.pattern_type===4?'nr4_color':'nr7_color'];
    objects.set('box:'+start,{shape:'rectangle',
      points:[point(start,d.pattern_high),point(d.pattern_end,d.pattern_low)],
      properties:{color:'rgba(0,0,0,0)',linewidth:0,backgroundColor:color,
        fillBackground:true,transparency:0},zOrder:'bottom'});
  }
  const lines=[];
  for(const [start,d] of ranges)for(const side of ['high','low','mid'])
    lines.push({key:'line:'+start+':'+side,start,end:d.range_end,price:d['range_'+side],side});
  // Three lines per NR; Pine drops individual oldest line objects at 500.
  for(const line of lines.slice(-500))if(line.end>line.start)objects.set(line.key,{
    shape:'trend_line',points:[point(line.start,line.price),point(line.end,line.price)],
    properties:{linecolor:inputs.range_color,linewidth:1,linestyle:line.side==='mid'?2:0,
      extendLeft:false,extendRight:false,showPriceLabels:false,showLabel:false},zOrder:'top'});
  // Pine label sizes differ from table/box text sizes (8/10/14/20/36).
  // https://www.tradingview.com/pine-script-docs/visuals/text-and-shapes/#text-formatting
  const sizes={Tiny:7,Small:10,Normal:12,Large:18,Huge:24};
  if(inputs.show_signals)for(const signal of signals.slice(-500))objects.set('signal:'+signal.time+':'+signal.side,{
    shape:'text',points:[point(signal.time,signal.price)],text:signal.side==='up'?'\n▲':'▼\n',
    properties:{color:inputs[signal.side+'_color'],fontsize:sizes[inputs.signal_size] || 10,
      fixedSize:true,bold:false,italic:false,fillBackground:false,drawBorder:false,
      wordWrap:false},zOrder:'top'});
  return objects;
}

function chartNRBreakoutDisplay({report=()=>{},centerText=globalThis.MWNativeIndicatorResults?.centerDrawingText}={}) {
  const bindings=new Map();
  function drop(binding,key,record) {
    binding.objects.delete(key);
    if(record.id!=null)try{binding.chart.removeEntity(record.id,{disableUndo:true});}catch{/* Owner removed. */}
  }
  function clear(consumer) {
    const binding=bindings.get(consumer.key);
    if(!binding)return;
    binding.alive=false;
    for(const [key,record] of binding.objects)drop(binding,key,record);
    bindings.delete(consumer.key);
  }
  function apply(binding,record) {
    const object=record.object,shape=binding.chart.getShapeById(record.id);
    if(object.shape==='text')centerText(binding.chart,record.id);
    shape.setPoints(object.points);
    shape.setProperties({...object.properties,...(object.text!==undefined?{text:object.text}:{})});
    record.applied=record.signature;
  }
  function order(binding) {
    // Native creation order can place an owner-bound group behind the price
    // series, even when individual create calls request "top". Once the batch
    // has settled, reapply the full Python drawing order: boxes, lines, labels.
    if([...binding.objects.values()].some(record=>record.id==null))return;
    for(const key of binding.order) {
      const record=binding.objects.get(key);
      if(record)binding.chart.getShapeById(record.id).bringToFront();
    }
  }
  function refresh(consumer) {
    if(consumer.meta.render_profile!=='nr_breakout_v1')return;
    const binding=bindings.get(consumer.key);
    if(!binding)return;
    if(binding.symbol!==consumer.chart.symbol() || binding.resolution!==consumer.chart.resolution()){
      clear(consumer);return;
    }
    const inputSignature=JSON.stringify(consumer.inputs);
    if(!binding.dirty && inputSignature===binding.inputSignature)return;
    binding.dirty=false;binding.inputSignature=inputSignature;
    const desired=nrBreakoutObjects([...binding.rows.values()].sort((a,b)=>a.time-b.time),consumer.inputs);
    binding.order=[...desired.keys()];
    for(const [key,record] of binding.objects)if(!desired.has(key))drop(binding,key,record);
    for(const [key,object] of desired) {
      const signature=JSON.stringify(object);
      let record=binding.objects.get(key);
      if(record){
        record.object=object;record.signature=signature;
        if(record.id!=null && record.applied!==signature)try{apply(binding,record);}catch(error){drop(binding,key,record);binding.dirty=true;report(error,consumer);}
        continue;
      }
      record={object,signature};binding.objects.set(key,record);
      const options={shape:object.shape,ownerStudyId:consumer.id,lock:true,disableSelection:true,
        disableSave:true,disableUndo:true,showInObjectsTree:false,zOrder:object.zOrder,
        overrides:object.properties,...(object.text!==undefined?{text:object.text}:{})};
      // Native creation is asynchronous. A correction/removal retires the
      // record; a late promise removes its own drawing instead of reviving it.
      void Promise.resolve().then(()=>object.shape==='text'
        ? binding.chart.createShape(object.points[0],options)
        : binding.chart.createMultipointShape(object.points,options)).then(id=>{
        if(!binding.alive || binding.objects.get(key)!==record) {
          try{binding.chart.removeEntity(id,{disableUndo:true});}catch{/* Owner removed. */}
          return;
        }
        record.id=id;
        apply(binding,record); // A newer accepted batch/style may have arrived.
        order(binding);
      }).catch(error=>{
        if(binding.alive && binding.objects.get(key)===record){drop(binding,key,record);binding.dirty=true;report(error,consumer);}
      });
    }
    order(binding);
  }
  return {
    update(consumer,{rows,kind,identity}) {
      if(consumer.meta.render_profile!=='nr_breakout_v1')return;
      const fingerprint=JSON.stringify(identity);
      let binding=bindings.get(consumer.key);
      if(binding && binding.fingerprint!==fingerprint){clear(consumer);binding=null;}
      if(!binding){binding={chart:consumer.chart,fingerprint,alive:true,rows:new Map(),objects:new Map(),
        symbol:consumer.chart.symbol(),resolution:consumer.chart.resolution()};bindings.set(consumer.key,binding);}
      if(kind==='snapshot')binding.rows.clear();
      for(const row of rows)binding.rows.set(row.time,row);
      binding.dirty=true;
      refresh(consumer);
    },
    clear,refresh,
    dispose(){for(const key of bindings.keys())clear({key});},
    diagnostics:()=>({bindings:bindings.size,objects:[...bindings.values()].reduce((n,b)=>n+b.objects.size,0)}),
  };
}
