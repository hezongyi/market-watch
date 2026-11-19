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
    .mw-mobile-crosshair-entry{width:44px;min-width:44px;height:38px;padding:0;justify-content:center;touch-action:manipulation}
    .mw-mobile-crosshair-entry:active{opacity:.65}
    @media(prefers-reduced-motion:no-preference){.mw-mobile-crosshair-entry{transition:color 120ms,background-color 120ms,opacity 120ms}}
    .mw-mobile-crosshair-entry svg{width:24px;height:24px;flex-shrink:0}
    .mw-mobile-crosshair-entry[aria-pressed="true"]{color:var(--tv-color-toolbar-button-text-active,#2962ff);background:var(--tv-color-toolbar-button-background-active,rgba(41,98,255,.12))}
    .mw-mobile-crosshair-entry:focus-visible{outline:2px solid #2962ff;outline-offset:-3px}
    .chart-container .tv-spinner{display:none!important}
  `;
  doc.head.append(style);
  const tracking = () => widget.activeChart()._chartWidget.paneWidgets().some(pane => pane.trackingModeEnabled());
  // Match the native drawing toolbar's cursor glyph, including its open center.
  // Render directly because the native palette may not have mounted yet.
  const crosshairIcon = '<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true"><path d="M18 15h8v-1h-8zM14 18v8h1v-8zM14 3v8h1v-8zM3 15h8v-1h-8z"/></svg>';
  const decorate = () => {
    for (const intervals of doc.querySelectorAll('#header-toolbar-intervals'))
      intervals.parentElement.parentElement.classList.add('mw-mobile-header-row');
    for (const button of doc.querySelectorAll('button[data-name="custom-tradingview-styled-button"][aria-label="十字线"]')) {
      if (!button.classList.contains('mw-mobile-crosshair-entry')) {
        button.classList.add('mw-mobile-crosshair-entry');
        (button.querySelector('.js-button-text') || button).innerHTML = crosshairIcon;
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

/** Announces when a native mobile chart can be used. */
function mobileChartReadiness(widget, send, settle, usable) {
  const chart = widget.activeChart();
  let generation = 0, selected = '', closed = false;
  const identity = () => ({symbol:chart.symbolExt?.()?.ticker || chart.symbol(),
    resolution:chart.resolution(),theme:widget.getTheme().toLowerCase()});
  const key = value => JSON.stringify(value);
  const current = (version, target) => !closed && generation===version && key(identity())===key(target);
  async function loaded() {
    const target=identity(), version=generation;
    if (!usable() || !chart.dataReady()) return;
    await settle(target,()=>current(version,target));
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(!current(version,target) || !chart.dataReady())return;
      send({type:'mobile-display-ready',...target});
    }));
  }
  function changed() {
    const target=identity(), next=key(target);
    if(next===selected)return;
    selected=next;generation++;
    send({type:'mobile-display-pending',...target});
    void loaded();
  }
  chart.onSymbolChanged().subscribe(null,changed);
  chart.onIntervalChanged().subscribe(null,changed);
  chart.onDataLoaded().subscribe(null,loaded);
  widget.subscribe('chart_theme_changed',changed);
  changed();
  return {changed,loaded,
    dispose() {closed=true;generation++;
      chart.onSymbolChanged().unsubscribe(null,changed);chart.onIntervalChanged().unsubscribe(null,changed);
      chart.onDataLoaded().unsubscribe(null,loaded);widget.unsubscribe('chart_theme_changed',changed);
    }};
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
