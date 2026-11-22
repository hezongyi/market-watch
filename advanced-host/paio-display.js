/* PAIO rendering adapter, © fengyangsi adaptation, MPL-2.0.
 * Python owns every object, condition, coordinate and lifecycle decision.
 * Host-only work: above/below-bar spacing, style inputs and disposable shapes.
 */
function paioObjects(snapshot, inputs, chart) {
  const result=new Map(),point=(time,price)=>({time:time/1000,price});
  const sizes={auto:12,tiny:7,small:10,normal:12,large:18,huge:24};
  const styles={solid:0,dotted:1,dashed:2};
  const numeric=value=>Number.isFinite(value);
  for(const obj of snapshot?.objects || []) {
    const color=inputs[obj.color] || '#787b86';
    let object;
    if(obj.kind==='box' && [obj.left,obj.right,obj.top,obj.bottom].every(numeric)) {
      object={shape:'rectangle',points:[point(obj.left,obj.top),point(obj.right,obj.bottom)],
        properties:{color:'rgba(0,0,0,0)',linewidth:0,backgroundColor:color,
          fillBackground:true,transparency:0},zOrder:'bottom'};
    } else if(obj.kind==='line' && [obj.left,obj.right,obj.price].every(numeric)) {
      const style=inputs[obj.style] || 'solid';
      object={shape:'trend_line',points:[point(obj.left,obj.price),point(obj.right,obj.price)],
        properties:{linecolor:color,linewidth:obj.width,linestyle:styles[style] ?? 0,
          leftEnd:['arrow_left','arrow_both'].includes(style)?1:0,
          rightEnd:['arrow_right','arrow_both'].includes(style)?1:0,
          extendLeft:false,extendRight:false,showPriceLabels:false,showLabel:false},zOrder:'top'};
    } else if(obj.kind==='label' && numeric(obj.time)) {
      let price=obj.price;
      const font=sizes[inputs[obj.size] || obj.size] || 12;
      if(obj.location!=='price') {
        const range=Math.max(Math.abs(obj.bar_high-obj.bar_low),Math.abs(obj.bar_high)*.0001);
        let distance=range*.18;
        try {
          const pane=chart.getPanes()[0],scale=pane.getMainSourcePriceScale(),visible=scale.getVisiblePriceRange();
          if(visible && pane.getHeight()>0)distance=(visible.to-visible.from)*(font+5)/pane.getHeight();
        } catch { /* The public pane API is absent in some embedded runtimes. */ }
        price=obj.location==='abovebar'?obj.bar_high+distance:obj.bar_low-distance;
      }
      if(!numeric(price))continue; // na-coordinate objects still count in Python's ledger.
      object={shape:'text',points:[point(obj.time,price)],text:obj.text,
        properties:{color,fontsize:font,fixedSize:true,bold:false,italic:false,
          fillBackground:false,drawBorder:false,wordWrap:false},zOrder:'top'};
    }
    if(object)result.set(obj.id,object);
  }
  return result;
}

function chartPAIODisplay({report=()=>{},centerText=globalThis.MWNativeIndicatorResults?.centerDrawingText}={}) {
  const bindings=new Map();
  function drop(binding,key,record) {
    binding.objects.delete(key);
    if(record.id!=null)try{binding.chart.removeEntity(record.id,{disableUndo:true});}catch{}
  }
  function clear(consumer) {
    const binding=bindings.get(consumer.key);
    if(!binding)return;
    binding.alive=false;
    for(const [key,record] of binding.objects)drop(binding,key,record);
    bindings.delete(consumer.key);
  }
  function apply(binding,record) {
    const obj=record.object,shape=binding.chart.getShapeById(record.id);
    if(obj.shape==='text')centerText?.(binding.chart,record.id);
    shape.setPoints(obj.points);
    shape.setProperties({...obj.properties,...(obj.text!==undefined?{text:obj.text}:{})});
    record.applied=record.signature;
  }
  function refresh(consumer) {
    if(consumer.meta.render_profile!=='paio_v1')return;
    const binding=bindings.get(consumer.key);
    if(!binding)return;
    if(binding.symbol!==consumer.chart.symbol() || binding.resolution!==consumer.chart.resolution()){
      clear(consumer);return;
    }
    const plotSignature=JSON.stringify([consumer.inputs.pv1stColor,consumer.inputs.pv2ndColor,consumer.inputs.pv3rdColor,
      consumer.params?.pv1stWidth,consumer.params?.pv2ndWidth,consumer.params?.pv3rdWidth]);
    if(binding.plotSignature!==plotSignature){
      const overrides={};
      for(let i=0;i<3;i++){
        const prefix='pv'+['1st','2nd','3rd'][i];
        if(consumer.inputs[prefix+'Color'])overrides['pv_'+(i+1)+'.color']=consumer.inputs[prefix+'Color'];
        if(consumer.params?.[prefix+'Width'])overrides['pv_'+(i+1)+'.linewidth']=consumer.params[prefix+'Width'];
      }
      try{binding.chart.getStudyById(consumer.id).applyOverrides(overrides);binding.plotSignature=plotSignature;}
      catch(error){report(error,consumer);}
    }
    const inputSignature=JSON.stringify(consumer.inputs);
    if(!binding.dirty && inputSignature===binding.inputSignature)return;
    binding.dirty=false;binding.inputSignature=inputSignature;
    const desired=paioObjects(binding.snapshot,consumer.inputs,binding.chart);
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
      void Promise.resolve().then(()=>object.shape==='text'
        ? binding.chart.createShape(object.points[0],options)
        : binding.chart.createMultipointShape(object.points,options)).then(id=>{
        if(!binding.alive || binding.objects.get(key)!==record){
          try{binding.chart.removeEntity(id,{disableUndo:true});}catch{}
          return;
        }
        record.id=id;
        apply(binding,record);
      }).catch(error=>{
        if(binding.alive && binding.objects.get(key)===record){drop(binding,key,record);binding.dirty=true;report(error,consumer);}
      });
    }
  }
  return {
    needsSnapshot:consumer=>consumer.meta.render_profile==='paio_v1' && !bindings.has(consumer.key),
    update(consumer,{identity,presentation}) {
      if(consumer.meta.render_profile!=='paio_v1' || presentation?.schema!=='paio_presentation_v1')return;
      const fingerprint=JSON.stringify(identity);
      let binding=bindings.get(consumer.key);
      if(binding && binding.fingerprint!==fingerprint){clear(consumer);binding=null;}
      if(!binding){binding={chart:consumer.chart,fingerprint,alive:true,objects:new Map(),
        symbol:consumer.chart.symbol(),resolution:consumer.chart.resolution()};bindings.set(consumer.key,binding);}
      binding.snapshot=presentation;binding.dirty=true;
      refresh(consumer);
    },clear,refresh,
    dispose(){for(const key of bindings.keys())clear({key});},
    diagnostics:()=>({bindings:bindings.size,objects:[...bindings.values()].reduce((n,b)=>n+b.objects.size,0)}),
  };
}
