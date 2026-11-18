/* One transient event overlay; owns only its entities, never persists or mutates alerts. */
function mobileAlertEvent(widget, container, send, readRows, readEventBar) {
  const chart = widget.activeChart();
  let generation = 0, entities = [], stopped = false, active, ownChange = false;
  let tail = Promise.resolve(), restoreView;
  const documents = new Set();
  const view = () => ({...identity(), range:chart.getVisibleRange()});
  const identity = () => ({ symbol: chart.symbolExt?.()?.ticker || chart.symbol(), resolution: chart.resolution() });
  function clear(restore = true) {
    if (restore && active?.locating) restoreView = view();
    generation++; active = undefined;
    for (const id of entities) { try { chart.removeEntity(id); } catch {} }
    entities = [];
  }
  const changed = () => { if (!ownChange && active && (!MWSeries.same(identity().symbol,active.symbol) || identity().resolution!==active.resolution)) { const target=active; clear(); send({type:'mobile-event-location',...target,status:'changed',reason:'已切换图表'}); } };
  chart.onSymbolChanged().subscribe(null,changed); chart.onIntervalChanged().subscribe(null,changed);
  const gesture=()=>{if(active?.locating){const target=active;clear();send({type:'mobile-event-location',...target,status:'changed',reason:'定位已取消，可重新定位'});}};
  const gestureEnd=()=>{if(restoreView)restoreView=view();};
  function bind(root) {
    if (!root || documents.has(root)) return;
    documents.add(root); root.addEventListener('pointerdown',gesture,true);root.addEventListener('pointerup',gestureEnd,true);
    for(const frame of root.querySelectorAll('iframe')) {try{bind(frame.contentDocument);}catch{}}
  }
  bind(container);
  const frames=setInterval(()=>{for(const frame of container.querySelectorAll('iframe'))try{bind(frame.contentDocument);}catch{}},500);
  function enqueue(operation) {
    tail=tail.catch(()=>{}).then(operation);
    return tail;
  }
  async function restoreCancelled() {
    if(stopped || active || !restoreView)return;
    const target=restoreView;restoreView=undefined;ownChange=true;
    try {
      if(!MWSeries.same(identity().symbol,target.symbol))await chart.setSymbol(target.symbol);
      if(chart.resolution()!==target.resolution)await chart.setResolution(target.resolution);
      if(target.range)await chart.setVisibleRange(target.range,{rejectByTimeout:20000});
    }finally{ownChange=false;}
  }
  async function locate(target) {
    clear(false); restoreView=undefined; const version = generation;
    const initialView=view();
    active = {token:target.token,eventId:target.eventId,symbol:target.symbol,resolution:target.resolution,locating:true};
    const current = () => !stopped && generation === version;
    const check = () => { if (!current()) throw Error('cancelled'); };
    let timer;
    const timeout = new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('定位超时，请重试')),25000);});
    const waitReady=()=>new Promise((resolve,reject)=>{
      const until=Date.now()+15000;
      const poll=setInterval(()=>{if(!current()||Date.now()>=until){clearInterval(poll);reject(Error(current()?'历史数据未就绪，请重试':'cancelled'));}},100);
      try{chart.dataReady(()=>{clearInterval(poll);resolve();});}catch(error){clearInterval(poll);reject(error);}
    });
    const task = async () => {
      check(); ownChange=true;
      try {
        if (!MWSeries.same(identity().symbol,target.symbol)) {
          const ok=await chart.setSymbol(target.symbol); check();
          if(ok===false)throw Error('行情身份无法加载');
        }
        if(chart.resolution()!==target.resolution) { await chart.setResolution(target.resolution); check(); }
      } finally {ownChange=false;}
      if(!MWSeries.same(identity().symbol,target.symbol)||chart.resolution()!==target.resolution)throw Error('图表已切换');
      await waitReady(); check();
      const widths={'1':60,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'1D':86400,'1W':604800,'1M':2678400};
      let anchor=(readEventBar?.(chart,target)?.time ?? target.anchorMs/1000);
      const width=target.bar ? (target.bar.end-target.bar.start)/1000 : widths[target.resolution];
      const includesAnchor=()=>{const value=chart.getVisibleRange();return value && value.from<=anchor && value.to>=anchor;};
      if(!includesAnchor()) {
        try {await chart.setVisibleRange({from:anchor-width*60,to:anchor+width*20},{rejectByTimeout:18000});}
        catch(error){if(!includesAnchor())throw error;}
        check();
      }
      await waitReady(); check();
      const matched=readEventBar?.(chart,target);
      if(matched)anchor=matched.time;
      const range=chart.getVisibleRange();
      if(!range || anchor<range.from || anchor>range.to) {
        await chart.setVisibleRange({from:anchor-width*6,to:anchor+width*3},{rejectByTimeout:20000});check();
      }
      const actual=chart.getVisibleRange(), rows=readRows(chart) || [];
      if(!MWSeries.same(identity().symbol,target.symbol)||chart.resolution()!==target.resolution)throw Error('图表已切换');
      if(!actual || anchor<actual.from || anchor>actual.to)throw Error('目标时间不在可见范围');
      let row;
      if(target.bar)row=matched && rows.find(r=>r[0]===matched.time);
      else row=matched && rows.find(r=>r[0]===matched.time);
      if(!row)throw Error('该时段没有可核实的历史 K 线');
      const options={lock:true,disableSelection:true,disableSave:true,disableUndo:true,showInObjectsTree:false};
      const add = async (point, value) => { const id=await chart.createShape(point,{...options,...value}); if(!current()){if(id)try{chart.removeEntity(id);}catch{};throw Error('cancelled');} if(id)entities.push(id); };
      await add({time:row[0]},{shape:'vertical_line',text:target.anchorKind==='evidence-bar'?'判定柱':target.anchorKind==='intrabar-time'?'触发时点':'判定柱待核实',overrides:{linecolor:'#7189ad',linestyle:2,linewidth:1,showLabel:true}});
      const price=Number(target.threshold);
      if(target.leftKind==='price' && Number.isFinite(price))await add({time:row[0],price},{shape:'horizontal_line',text:'当时阈值',overrides:{linecolor:'#7189ad',linestyle:2,linewidth:1,showLabel:true}});
      check();active.locating=false;
      send({type:'mobile-event-location',token:target.token,eventId:target.eventId,...identity(),status:'located',reason:matched?.versionChanged?'行情版本已更新，显示当前历史；条件取自触发记录':target.anchorKind==='approximate-time'?'判定柱待核实':undefined});
    };
    const work=enqueue(async()=>{try{await task();}finally{await restoreCancelled();}});
    try {await Promise.race([work,timeout]);}
    catch(error) {if(current()){clear();restoreView=initialView;void enqueue(restoreCancelled).catch(()=>{});send({type:'mobile-event-location',token:target.token,eventId:target.eventId,...identity(),status:'error',reason:String(error.message||error)});}}
    finally {clearTimeout(timer);}
  }
  return {locate,clear,latest(){clear(false);restoreView=undefined;return enqueue(()=>{if(!stopped)chart.getTimeScale().setRightOffset(5);});},dispose(){stopped=true;clear(false);clearInterval(frames);chart.onSymbolChanged().unsubscribe(null,changed);chart.onIntervalChanged().unsubscribe(null,changed);for(const root of documents){root.removeEventListener('pointerdown',gesture,true);root.removeEventListener('pointerup',gestureEnd,true);}documents.clear();}};
}
