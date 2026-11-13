/* Local settings only: no server preference revisions, drafts or cross-tab hints. */
function mobileChartPreferences(initial, rpc, report) {
  const settings = Object.fromEntries(initial.filter(row=>row.kind==='setting').map(row=>[row.name,row.content.value]));
  return {
    dispose() {},
    savePreference: (_kind,name,value) => rpc('save',{name,value}),
    templates: {},
    settings: {
      initialSettings: settings,
      setValue: (name,value) => {void rpc('save',{name,value}).catch(report);},
      removeValue: name => {void rpc('delete',{name}).catch(report);},
    },
  };
}

// Header shortcut activates the native touch crosshair, not the drawing palette.
function mobileChartCrosshairEntry(widget, report) {
  const probe = widget.createButton({useTradingViewStyle: false});
  const doc = probe.ownerDocument;
  widget.removeButton(probe);
  const style = doc.createElement('style');
  style.textContent = `
    .mw-mobile-header-row > div{order:50}
    .mw-mobile-header-row > div:has(#header-toolbar-intervals){order:10}
    .mw-mobile-header-row > div:has(.mw-mobile-crosshair-entry){order:20}
    .mw-mobile-header-row > div:has(#header-toolbar-indicators){order:30}
    .mw-mobile-header-row > div:has(#header-toolbar-chart-styles){order:40}
    .mw-mobile-header-row > .separatorWrap-MBOVGQRI{display:none}
    .mw-mobile-crosshair-entry .js-button-text{display:flex;align-items:center;justify-content:center;width:100%;height:100%;line-height:0}
    .mw-mobile-crosshair-entry{width:38px;min-width:38px;padding:0;justify-content:center}
    .mw-mobile-crosshair-entry svg{width:24px;height:24px;flex-shrink:0}
    .mw-mobile-crosshair-entry[aria-pressed="true"]{color:var(--tv-color-toolbar-button-text-active,#2962ff);background:var(--tv-color-toolbar-button-background-active,rgba(41,98,255,.12))}
    .mw-mobile-crosshair-entry:focus-visible{outline:2px solid #2962ff;outline-offset:-3px}
    .chart-container .tv-spinner{display:none!important}
  `;
  doc.head.append(style);
  const tracking = () => widget.activeChart()._chartWidget.paneWidgets().some(pane => pane.trackingModeEnabled());
  const decorate = () => {
    for (const intervals of doc.querySelectorAll('#header-toolbar-intervals'))
      intervals.parentElement.parentElement.classList.add('mw-mobile-header-row');
    for (const button of doc.querySelectorAll('button[data-name="custom-tradingview-styled-button"][aria-label="十字线"]')) {
      if (!button.classList.contains('mw-mobile-crosshair-entry')) {
        button.classList.add('mw-mobile-crosshair-entry');
        (button.querySelector('.js-button-text') || button).insertAdjacentHTML('afterbegin',
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/><circle cx="12" cy="12" r="5"/></svg>');
      }
      button.setAttribute('aria-pressed', String(tracking()));
    }
  };
  // Keep the native drawing toolbar available from its edge handle.
  if (widget.activeChart().getCheckableActionState('drawingToolbarAction'))
    widget.activeChart().executeActionById('drawingToolbarAction');
  const setEnabled = async enabled => {
    if (enabled) await widget.selectLineTool('cursor');
    mobileChartCrosshair(widget, enabled);
    decorate();
  };
  const button = widget.createButton({align: 'left', useTradingViewStyle: true,
    text: '', title: '十字线',
    onClick: () => {void setEnabled(!tracking()).catch(report);}});
  const crosshair = widget.activeChart().crossHairMoved();
  crosshair.subscribe(null, decorate);
  // Native tap/long-press can enter or leave tracking without using our button.
  let frame;
  const afterGesture = () => {cancelAnimationFrame(frame);frame=requestAnimationFrame(decorate);};
  doc.addEventListener('pointerup', afterGesture);
  doc.addEventListener('touchend', afterGesture);
  const observer = new MutationObserver(decorate);
  observer.observe(doc.body, {childList: true, subtree: true});
  decorate();
  return {setEnabled, dispose() {
    observer.disconnect();
    cancelAnimationFrame(frame);
    crosshair.unsubscribe(null, decorate);
    doc.removeEventListener('pointerup', afterGesture);
    doc.removeEventListener('touchend', afterGesture);
    widget.removeButton(button);
    style.remove();
  }};
}

// Mobile keeps the vendor's search, rows, favorites and add callbacks. Only
// supply custom study metadata omitted by the pinned native controller.
function mobileChartNativeIndicators(widget, doc) {
  const win = doc.defaultView, moduleId = 217583;
  if (!String(TradingView.version()).includes('6b804c486857f27920cf761aa7eb6e29d9bb6362'))
    throw Error('当前原生指标版本尚未适配');
  let req, controller;
  win.webpackChunktradingview.push([[`mw-mobile-indicators-${crypto.randomUUID()}`], {}, value => {req=value;}]);
  function adapt(original) {
    if (original.mwMobileIndicators) return original;
    function factory(module, exports, nativeRequire) {
      original(module, exports, nativeRequire);
      const Native = module.exports.IndicatorsLibraryContainer;
      class Controller extends Native {
        constructor(...args) {super(...args); controller=this;}
        async _requestBuiltInJavaStudies() {
          const rows = await super._requestBuiltInJavaStudies();
          this.mwPython = rows.filter(row => row.isCustomIndicator && row.description.startsWith('守望 Python '));
          return rows;
        }
        async _init() {
          await super._init();
          const present = new Set(this._indicatorData.map(row => row.id));
          for (const meta of this.mwPython || []) if (!present.has(meta.id)) {
            this._indicatorData.push({id:meta.id,title:meta.description,
              shortDescription:meta.shortDescription,shortTitle:meta.shortDescription,
              isStrategy:false,isHidden:false,isOverlay:meta.is_price_study,
              studyData:{id:meta.id,version:meta.version,
                descriptor:{type:'java',studyId:meta.id},packageName:'market-watch-1'}});
          }
          this._refreshFavorites();
        }
      }
      module.exports = {...module.exports, IndicatorsLibraryContainer:Controller};
    }
    factory.mwMobileIndicators = true;
    return factory;
  }
  if (req.m[moduleId]) req.m[moduleId] = adapt(req.m[moduleId]);
  const previousPush = win.webpackChunktradingview.push;
  const push = function(chunk) {
    if (chunk[1]?.[moduleId]) chunk[1][moduleId] = adapt(chunk[1][moduleId]);
    return previousPush.call(this, chunk);
  };
  win.webpackChunktradingview.push = push;
  return {open() {widget.activeChart().executeActionById('insertIndicator');},
    close() {controller?.hide();}, dispose() {controller?.hide();
      if(win.webpackChunktradingview.push===push)win.webpackChunktradingview.push=previousPush;}};
}

/** A bounded picture of the last rendered chart; never fed back as market data. */
function mobileChartContinuity(widget, doc, send, layout, settle, usable) {
  const chart = widget.activeChart();
  let generation = 0, selected = '', closed = false, timer, failed = false, capturing = false, rendered = false;
  const identity = () => ({symbol:chart.symbolExt?.()?.ticker || chart.symbol(),
    resolution:chart.resolution(),theme:widget.getTheme().toLowerCase()});
  const key = value => JSON.stringify(value);
  const current = (version, target) => !closed && generation===version && key(identity())===key(target);
  async function capture() {
    if (closed || capturing || !rendered || document.hidden || !usable() || !chart.dataReady()) return;
    const target = identity(), version = generation;
    capturing = true;
    try {
      const canvas = await widget.takeClientScreenshot();
      if (!current(version,target) || !canvas.width || !canvas.height) return;
      // Limit pixel memory and persistence size even on high-DPI phones.
      const scale = Math.min(1, 900/canvas.width, 1600/canvas.height);
      const image = document.createElement('canvas');
      image.width = Math.round(canvas.width*scale); image.height = Math.round(canvas.height*scale);
      image.getContext('2d').drawImage(canvas,0,0,image.width,image.height);
      const toolbar=doc.querySelector('[data-name="header-toolbar"]');
      send({type:'mobile-preview',...target,image:image.toDataURL('image/webp',.82),at:Date.now(),layout:layout(),
        top:toolbar?.getBoundingClientRect().bottom || 46,bottom:0});
    } catch { /* Preview failure must not interrupt live charts or local saves. */ }
    finally {capturing=false;}
  }
  async function loaded() {
    const target=identity(), version=generation;
    if (!usable() || !chart.dataReady()) return;
    await settle(target,()=>current(version,target) && !failed);
    // Let native studies and canvas paints commit before releasing the preview.
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(!current(version,target) || !chart.dataReady())return;
      rendered=true;
      send({type:'mobile-display-ready',...target});
      clearTimeout(timer);timer=setTimeout(()=>{void capture();},450);
    }));
  }
  function changed() {
    const target=identity(), next=key(target);
    if(next===selected)return;
    selected=next;generation++;failed=false;rendered=false;clearTimeout(timer);
    send({type:'mobile-display-pending',...target});
    void loaded();
  }
  const edited=()=>{clearTimeout(timer);timer=setTimeout(()=>{void capture();},650);};
  const invalidate=()=>{if(rendered){send({type:'mobile-preview-invalidated'});rendered=false;void loaded();edited();}};
  // Native restoration also emits these events. Only real content changes
  // invalidate other periods; repeated type/scale notifications keep previews.
  let chartType = chart.chartType();
  const typeChanged=()=>{const next=chart.chartType();if(next!==chartType){chartType=next;invalidate();}};
  const studies=new Set(chart.getAllStudies().map(study=>study.id));
  const studyChanged=(id,event)=>{
    if(event==='remove'){if(studies.delete(id))invalidate();}
    else if(event==='create' || event==='paste_study'){if(!studies.has(id)){studies.add(id);invalidate();}}
  };
  const drawingChanged=(_id,event)=>{if(['create','remove','hide','show','properties_changed','points_changed'].includes(event))invalidate();};
  chart.onSymbolChanged().subscribe(null,changed);
  chart.onIntervalChanged().subscribe(null,changed);
  chart.onDataLoaded().subscribe(null,loaded);
  widget.subscribe('chart_theme_changed',changed);
  widget.subscribe('onAutoSaveNeeded',edited);
  widget.subscribe('study_event',studyChanged);
  widget.subscribe('study_properties_changed',invalidate);
  widget.subscribe('drawing_event',drawingChanged);
  chart.onChartTypeChanged().subscribe(null,typeChanged);
  const refresh=setInterval(()=>{if(!document.hidden)void capture();},30000);
  changed();
  return {capture,changed,loaded,
    indicator(state) {if(state==='error' || state==='unavailable' || state==='insufficient_input'){failed=true;void loaded();}},
    invalidate,
    dispose() {closed=true;generation++;clearTimeout(timer);clearInterval(refresh);
      chart.onSymbolChanged().unsubscribe(null,changed);chart.onIntervalChanged().unsubscribe(null,changed);
      chart.onDataLoaded().unsubscribe(null,loaded);widget.unsubscribe('chart_theme_changed',changed);
      chart.onChartTypeChanged().unsubscribe(null,typeChanged);
      widget.unsubscribe('study_event',studyChanged);
      widget.unsubscribe('study_properties_changed',invalidate);
      widget.unsubscribe('drawing_event',drawingChanged);
      widget.unsubscribe('onAutoSaveNeeded',edited);}};
}

function mobileChartParameterDialogs(container) {
  const doc=container.querySelector('iframe')?.contentDocument;
  return [...doc?.querySelectorAll('[data-name="indicator-properties-dialog"],[data-name="series-properties-dialog"],[data-name="chart-properties-dialog"]') || []]
    .filter(node=>!node.hidden && node.getBoundingClientRect().height>0);
}
function mobileChartParameterEditing(container) {
  return mobileChartParameterDialogs(container).length > 0;
}
function mobileChartCancelParameters(container) {
  for (const dialog of mobileChartParameterDialogs(container)) {
    const cancel = [...dialog.querySelectorAll('button')].find(button=>button.textContent.trim()==='取消');
    if (!cancel) throw Error('请先在图表参数中取消本次修改');
    cancel.click();
  }
}

/** Pinned v31 touch tracking, using its own crosshair and touch handling. */
function mobileChartCrosshair(widget, enabled) {
  if (!String(TradingView.version()).includes('6b804c486857f27920cf761aa7eb6e29d9bb6362'))
    throw Error('当前图表版本的触屏十字线尚未适配');
  const chart = widget.activeChart()._chartWidget;
  const panes = chart?.paneWidgets?.();
  if (!panes?.length) throw Error('十字线尚未就绪');
  if (!enabled) {
    for (const pane of panes) pane.exitTrackingMode();
    chart.model().model().clearCurrentPosition();
    return false;
  }
  const pane = panes[0];
  const point = chart.model().model().crosshairSource().currentPoint().clone();
  if (!Number.isFinite(point.x) || point.x <= 0 || point.x >= pane.size().width) point.x = pane.size().width / 2;
  if (!Number.isFinite(point.y) || point.y <= 0 || point.y >= pane.size().height) point.y = pane.size().height / 2;
  pane.startTrackingMode(point, point);
  return pane.trackingModeEnabled();
}
