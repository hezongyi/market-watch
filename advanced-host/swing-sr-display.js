/* Render Python snapshots with public study/drawing APIs and host-owned HTML.
 * Derived drawings/rows are disposable; only native study inputs are persisted.
 */
function swingSnapshotKey(symbol, resolution, params) {
  return JSON.stringify([symbol, resolution, params.high_strength, params.low_strength]);
}

// Published/provider revisions are monotonic database counters. Hash revisions
// have no numeric order and retain the request/generation fences below.
function swingRevisionOrder(next, previous) {
  if (!/^\d+$/.test(String(next)) || !/^\d+$/.test(String(previous))) return null;
  const a=BigInt(next),b=BigInt(previous);
  return a < b ? -1 : a > b ? 1 : 0;
}

function swingSnapshotStore() {
  const records = new Map();
  let sequence = 0;
  return {
    ticket: () => ++sequence,
    clear: () => records.clear(),
    get: (symbol, resolution, params) => records.get(swingSnapshotKey(symbol, resolution, params)),
    publish(symbol, resolution, page, ticket) {
      let accepted=false;
      for (const result of page.indicators || []) {
        const p = result.presentation;
        if (result.name !== 'SWING_SR_V1' || p?.render_profile !== 'swing_sr_v1') continue;
        const key = swingSnapshotKey(symbol, resolution, result.params);
        const previous = records.get(key);
        const revision=p.history_revision ?? page.history_revision ?? page.revision ?? null;
        const sameRevision=previous?.presentation.history_revision===revision;
        const order=previous ? swingRevisionOrder(revision,previous.presentation.history_revision) : null;
        // A source revision wins over request/arrival order, including repairs
        // that retract the latest bar. Unknown revisions retain ticket fencing.
        if (previous && (order===-1 || (order!==1 && ticket < previous.ticket) || sameRevision &&
          p.as_of_bar_time < previous.presentation.as_of_bar_time)) continue;
        // Never replace a complete range by a warmup/page-local statistic.
        if (previous && sameRevision && p.statistics_origin > previous.presentation.statistics_origin) continue;
        records.set(key, {ticket, presentation:{...p,
          history_revision:revision,
          history_complete:p.history_complete ?? !(page.indicator_progress || []).some(s=>s.status!=='complete'),
        }, bars:page.bars || []});
        accepted=true;
      }
      return accepted;
    },
  };
}

function swingDisplayInputs(study) {
  const input = Object.fromEntries(study.getInputValues().map(item=>[item.id,item.value]));
  const repairs=[];
  for(const [key,fixed] of [['hh_source','high'],['ll_source','low']])
    if(input[key]!==fixed) {input[key]=fixed;repairs.push({id:key,value:fixed});}
  if(typeof input.show_average_spacing!=='boolean') {
    input.show_average_spacing=true;repairs.push({id:'show_average_spacing',value:true});
  }
  // Migrate the old display placement without changing hidden statistics or
  // strengths. Persist through native inputs so templates and reload agree.
  if(input.statistics_position!=='bottom_left') {
    input.statistics_position='bottom_left';repairs.push({id:'statistics_position',value:'bottom_left'});
  }
  if(repairs.length) study.setInputValues(repairs);
  const params = {high_strength:input.high_strength,low_strength:input.low_strength};
  if (!Object.values(params).every(value=>Number.isInteger(value) && value>=1 && value<=500) ||
      input.hh_source !== 'high' || input.ll_source !== 'low' ||
      typeof input.show_average_spacing !== 'boolean' ||
      !['below_name','bottom_left'].includes(input.statistics_position)) return null;
  return {params,show:input.show_average_spacing,position:input.statistics_position};
}

// Use the existing native pane adapter's canvas bounds, including resized and
// maximized layouts. No private DOM class names or native legend edits.
function swingPaneBounds(chart, root) {
  const pane = chart._chartWidget.paneWidgets().find(pane=>pane.containsMainSeries());
  const canvas = pane?.canvasElement();
  if(!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  let left=rect.left,top=rect.top,win=canvas.ownerDocument.defaultView;
  const hostWindow=root.ownerDocument.defaultView;
  while(win!==hostWindow) {
    const frame=win.frameElement;
    if(!frame) return null;
    const frameRect=frame.getBoundingClientRect();
    left+=frameRect.left;top+=frameRect.top;win=frame.ownerDocument.defaultView;
  }
  const host=root.getBoundingClientRect();
  return {left:left-host.left,top:top-host.top,width:rect.width,height:rect.height};
}

function chartSwingDisplay(widget, store, {root, identity, chartTime = time=>time, report = () => {}}) {
  const doc = root.ownerDocument;
  const bindings = new Map();
  const infoGroups = new Map(), cardGroups = new Map();
  let disposed = false, timer;
  const info = doc.createElement('div');
  info.className = 'mw-swing-information';
  info.setAttribute('aria-label','Swing 指标信息');
  root.before(info);
  const cards = doc.createElement('div');
  cards.className = 'mw-swing-cards';
  root.append(cards);
  const style = doc.createElement('style');
  style.textContent = `
    #chart {position:relative;flex:1;min-height:0}
    body:has(.mw-swing-information) {display:flex;flex-direction:column}
    .mw-swing-information:empty {display:none}
    .mw-swing-information {display:grid;gap:4px;padding:4px 8px;background:var(--mw-swing-bg,#171a20);color:var(--mw-swing-text,#e0e3eb)}
    .mw-swing-cards {position:absolute;inset:0;pointer-events:none;z-index:2}
    .mw-swing-row {font:12px/1.5 system-ui;min-width:0;overflow-wrap:anywhere}
    .mw-swing-row summary {cursor:help;list-style:none;outline-offset:2px}
    .mw-swing-row summary:focus-visible {outline:2px solid #42a5f5}
    .mw-swing-name {display:block;font-weight:500}
    .mw-swing-high {color:var(--mw-swing-high,#ff6573)}
    .mw-swing-low {color:var(--mw-swing-low,#00cedf)}
    .mw-swing-card-stack {position:absolute;display:flex;flex-direction:column;gap:6px;overflow:auto;pointer-events:auto}
    .mw-swing-card {padding:6px 8px;border-radius:4px;background:var(--mw-swing-card,rgba(23,26,32,.88));color:var(--mw-swing-text,#e0e3eb);box-sizing:border-box}
    .mw-swing-card .mw-swing-title,.mw-swing-card .mw-swing-high,.mw-swing-card .mw-swing-low {display:block}
    .mw-swing-card .mw-swing-separator {display:none}
    .mw-swing-details {font-size:11px;max-width:32em}
  `;
  doc.head.append(style);

  function removeShape(binding, side) {
    const id = binding.shapes[side];
    if (id) {try {binding.chart.removeEntity(id,{disableUndo:true});} catch { /* Native may have removed the owner. */ }}
    binding.shapes[side] = null;
  }
  function remove(binding) {
    binding.alive = false;
    for (const side of ['high','low']) removeShape(binding,side);
    binding.row?.remove();
  }
  function reset() {
    for (const binding of bindings.values()) remove(binding);
    bindings.clear();
    store.clear();
    info.replaceChildren();
    cards.replaceChildren();
    infoGroups.clear();cardGroups.clear();
  }
  async function bridge(binding, side, event, end, input, styles) {
    if(!binding.chart.dataReady()) return;
    const indices = side==='high' ? [0,1] : [2,3];
    const plots = indices.map(i=>styles?.['plot'+i]);
    const visible = !plots.every(plot=>plot?.visible === false);
    const color = plots.find(plot=>plot?.visible !== false)?.color || (side==='high'?'#f23645':'#00bcd4');
    const width = Math.max(2,...plots.map(plot=>Number(plot?.linewidth)||1));
    const signature = JSON.stringify([input.params,event,end,visible,color,width]);
    if (binding.signatures[side] === signature) return;
    binding.signatures[side] = signature;
    const generation = ++binding.generations[side];
    if (!event || !visible || end == null || event.pivot_time >= end) {
      removeShape(binding,side);return;
    }
    const points = [{time:(event.pivot_chart_time ?? binding.time(event.pivot_time))/1000,price:event.price},
                    {time:binding.time(end)/1000,price:event.price}];
    if (binding.shapes[side]) {
      try {
        const shape = binding.chart.getShapeById(binding.shapes[side]);
        shape.setPoints(points);
        shape.setProperties({linecolor:color,linewidth:width,extendLeft:false,extendRight:false});
        return;
      } catch {removeShape(binding,side);}
    }
    try {
      const id = await binding.chart.createMultipointShape(points, {shape:'trend_line',
        ownerStudyId:binding.id,lock:true,disableSelection:true,disableSave:true,disableUndo:true,
        showInObjectsTree:false,overrides:{linecolor:color,linewidth:width,linestyle:0,
          extendLeft:false,extendRight:false,showPriceLabels:false,showLabel:false}});
      if (!binding.alive || generation !== binding.generations[side] || disposed) {
        try {binding.chart.removeEntity(id,{disableUndo:true});} catch { /* Owner removed. */ }
      } else binding.shapes[side] = id;
      binding.failures[side]=0;
    } catch(error) {
      binding.signatures[side] = null;
      if(binding.alive && generation===binding.generations[side] && ++binding.failures[side]===4)
        report(error);
    }
  }
  function statisticsRow(binding, input, p) {
    if (!input.show) {binding.row?.remove();binding.row=null;return;}
    if (!binding.row) {
      binding.row = doc.createElement('details');
      binding.row.className = 'mw-swing-row';
      const summary = doc.createElement('summary');
      const name = doc.createElement('span');name.className='mw-swing-name';
      const average = doc.createElement('span');average.className='mw-swing-title';average.textContent='平均间隔：';
      const high = doc.createElement('span');high.className='mw-swing-high';
      const low = doc.createElement('span');low.className='mw-swing-low';
      const separator=doc.createElement('span');separator.className='mw-swing-separator';separator.textContent=' · ';
      summary.append(name,average,high,separator,low);
      const detail = doc.createElement('div');detail.className='mw-swing-details';
      binding.row.append(summary,detail);
      binding.parts = {name,high,low,detail};
    }
    const parts = binding.parts;
    parts.name.textContent = `${widget.chartsCount()>1 ? '图表 '+(binding.index+1)+' · ' : ''}Swing ${input.params.high_strength} ${input.params.low_strength} high low`;
    for(const side of ['high','low']) parts[side].textContent =
      `${side==='high'?'高点':'低点'} ${p.statistics[side].display_integer ?? '—'}${p.statistics[side].display_integer == null ? '' : '根'}`;
    const date = value=>value == null ? '—' : new Date(value).toLocaleString('zh-CN');
    parts.detail.textContent = `范围 ${date(p.statistics_origin)} — ${date(p.as_of_bar_time)}；`+
      `事件 高点 ${p.statistics.high.confirmed_count}（预览 ${p.statistics.high.preview_count}），`+
      `低点 ${p.statistics.low.confirmed_count}（预览 ${p.statistics.low.preview_count}）`+
      (p.history_complete ? '' : '；历史统计尚未完成');
    const groups=input.position==='below_name'?infoGroups:cardGroups;
    let parent=groups.get(binding.index);
    if(!parent) {
      parent=doc.createElement('div');parent.className=input.position==='below_name'?'mw-swing-chart-info':'mw-swing-card-stack';
      groups.set(binding.index,parent);(input.position==='below_name'?info:cards).append(parent);
    }
    if(binding.row.parentNode !== parent) parent.append(binding.row);
    binding.row.classList.toggle('mw-swing-card',input.position==='bottom_left');
    binding.row.dataset.chart = String(binding.index);
  }
  function refresh() {
    if (disposed) return;
    const active = new Set();
    for(let index=0;index<widget.chartsCount();index++) {
      const chart = widget.chart(index);
      const ident = identity(chart.symbol());
      for(const item of chart.getAllStudies()) {
        if (item.name !== '守望 Python SWING_SR_V1' && item.name !== 'Swing') continue;
        const key = index + ':' + item.id;
        active.add(key);
        const study = chart.getStudyById(item.id), input = swingDisplayInputs(study);
        const fingerprint = JSON.stringify([chart.symbol(),chart.resolution(),input?.params]);
        let binding = bindings.get(key);
        if (binding && (binding.chart!==chart || binding.fingerprint!==fingerprint || !study.isVisible())) {
          remove(binding);bindings.delete(key);binding=null;
        }
        if (!input || !study.isVisible()) continue;
        if (!binding) {
          binding = {chart,id:item.id,index,fingerprint,alive:true,shapes:{},signatures:{},
            generations:{high:0,low:0},failures:{high:0,low:0}};
          bindings.set(key,binding);
        }
        const record = store.get(ident,chart.resolution(),input.params);
        if(!record) continue;
        const p = record.presentation;
        const chartTimes = new Map(record.bars.map(bar=>[bar.start,bar.chart_time ?? bar.start]));
        binding.time = time=>time===p.as_of_bar_time && p.as_of_chart_time!=null ?
          p.as_of_chart_time : chartTimes.get(time) ?? chartTime(time,chart);
        const styles = study.getStyleValues()?.styles || study.getStyleValues();
        for(const side of ['high','low']) void bridge(binding,side,p.current[side],p.as_of_bar_time,input,styles);
        statisticsRow(binding,input,p);
      }
    }
    for(const [key,binding] of bindings) if(!active.has(key)) {remove(binding);bindings.delete(key);}
    layout();
  }
  function layout() {
    // The information region owns and reserves its height. Native legend DOM is never inspected.
    const count = widget.chartsCount();
    const columns = widget.layout()==='2v' ? 1 : Math.min(count,2);
    info.style.gridTemplateColumns = `repeat(${columns},minmax(0,1fr))`;
    const dark = widget.getTheme().toLowerCase()==='dark';
    for(const element of [info,cards]) {
      element.style.setProperty('--mw-swing-bg',dark?'#171a20':'#ffffff');
      element.style.setProperty('--mw-swing-text',dark?'#e0e3eb':'#20242e');
      element.style.setProperty('--mw-swing-high',dark?'#ff6573':'#b51e32');
      element.style.setProperty('--mw-swing-low',dark?'#00cedf':'#007c88');
      element.style.setProperty('--mw-swing-card',dark?'rgba(23,26,32,.88)':'rgba(255,255,255,.94)');
    }
    for(const [index,group] of infoGroups) {
      if(!group.childElementCount) {group.remove();infoGroups.delete(index);continue;}
      group.style.cssText=`grid-column:${index%columns+1};grid-row:${Math.floor(index/columns)+1}`;
    }
    for(const [index,group] of cardGroups) {
      if(!group.childElementCount || index>=widget.chartsCount()) {group.remove();cardGroups.delete(index);continue;}
      const bounds=swingPaneBounds(widget.chart(index),root);
      if(!bounds || !bounds.width || !bounds.height) {group.style.display='none';continue;}
      group.style.display='';
      group.style.left=(bounds.left+8)+'px';
      group.style.width=Math.max(0,Math.min(210,bounds.width-24))+'px';
      group.style.maxHeight=Math.max(0,bounds.height-48)+'px';
      // The stack scrolls within its own pane when many instances are present.
      group.style.top=(bounds.top+bounds.height-32-group.offsetHeight)+'px';
    }
  }
  const refreshSafe=()=>{try {refresh();} catch(error) {report(error);}};
  const observer = new ResizeObserver(refreshSafe);observer.observe(root);
  widget.subscribe('chart_load_requested',reset);
  widget.subscribe('study_event',refreshSafe);
  widget.subscribe('layout_changed',refreshSafe);
  timer=setInterval(refreshSafe,250);
  refreshSafe();
  return {refresh:refreshSafe,reset,dispose() {
    disposed=true;clearInterval(timer);observer.disconnect();reset();
    widget.unsubscribe('chart_load_requested',reset);widget.unsubscribe('study_event',refreshSafe);
    widget.unsubscribe('layout_changed',refreshSafe);info.remove();cards.remove();style.remove();
  }};
}
