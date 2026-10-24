let activePreferences;
/* All authenticated work is performed by the trusted parent, never this origin. */
const parentOrigin = new URLSearchParams(location.search).get("parent");
if (!parentOrigin || new URL(parentOrigin).origin !== parentOrigin)
  throw Error("Missing parent origin");
// Narrow the header's HTTP(S) frame allowance to this authenticated app before
// creating any chart or management iframe. Blob documents inherit this policy.
const framePolicy = document.createElement("meta");
framePolicy.httpEquiv = "Content-Security-Policy";
framePolicy.content = `frame-src 'self' blob: ${parentOrigin}`;
document.head.append(framePolicy);
const send = (value) =>
  parent.postMessage({ channel: "mw-chart-v1", ...value }, parentOrigin);
const pending = new Map();
// Only draft recovery requires a native confirmation.
const acknowledgedNotices = new Set();
let ordinaryNotices;
let noticeUI, noticeState, noticeOpenEvent, alertOpenSignal;
let activeNotices = [], noticeDialogOpen = false, chartMenu, indicatorPicker, alertBridge, alertUI, alertUISession, alertUIDraft, alertUIWorkspace, alertUIAttach, dataCenter;
let invalidateAlertUI = () => {};
// Lazy loading keeps ordinary datafeed consumers independent of the renderer.
let swingSnapshots;
function swingStore() {return swingSnapshots ||= swingSnapshotStore();}
let swingDisplay, indicatorCoordinator, squeezeSnapshots, squeezeDisplay;
function squeezeStore() {return squeezeSnapshots ||= squeezeSnapshotStore();}
function publishSqueeze(ticker,res,page,ticket) {
  squeezeStore().publish(ticker,res,page,ticket ?? squeezeStore().ticket());squeezeDisplay?.refresh();
}
const indicatorBindings=new Map();
const indicatorDependencyOrigins=new Map();
function indicatorKey(ticker,res){
  const id=decode(ticker);
  return MWSeries.encode(id.symbol,id.series_kind)+'|'+res;
}
let studyTemplates, restoreAlertsPanel = false;
function showNextNotice() {
  if (!ready || noticeDialogOpen) return;
  const notice = activeNotices.find(entry => entry.recover && !acknowledgedNotices.has(entry.key));
  if (!notice) return;
  acknowledgedNotices.add(notice.key);
  noticeDialogOpen = true;
  const done = () => { noticeDialogOpen = false; showNextNotice(); };
  if (notice.recover) widget.showConfirmDialog({
    title: "草稿待恢复", body: notice.text,
    callback: confirmed => {
      if (confirmed) send({type: "workspace-action", action: "recover"});
      done();
    },
  });
}
let seq = 0,
  widget,
  ready = false,
  loading = false,
  poll,
  savedDoc = {},
  dirty = false,
  nativeMode = false,
  nativeSaving = false,
  workspaceEpoch = 0,
  nativeReadonly = false;
let barRangeMapping, syncCoordinator;
let watchlistLayout, symbolFlags, activeTab;
let captureWorkspaceState, discardWorkspaceChanges;
const watchlistMetadata = new Map();
let rangeGuard, edgeGuard, demandReporter, progressivePages, progressivePoll, beforeInitialHistory, initialSymbol;
let prewarming = false;
let autoSave, editRevision = 0, manualSavePending = false;
// The SHA-verified native chartSaved handler reads this after the async save
// adapter completes, so saving A cannot acknowledge a later edit B.
globalThis.MWNativeSave = { hasUnsavedChanges: () => dirty };
function markWorkspaceDirty() {
  if (nativeReadonly || !ready || loading) return;
  dirty = true;
  editRevision++;
  send({type: "workspace-dirty"});
}
const resolutions = ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"];
const frames = {
  1: "M1",
  5: "M5",
  15: "M15",
  30: "M30",
  60: "H1",
  240: "H4",
  "1D": "D1",
  "1W": "W1",
  "1M": "MN",
};
const subscriptions = new Map();
const quoteSubscriptions = new Map();
const marketPollingFallback = new URLSearchParams(location.search).get('marketPolling') === '1';
const marketHistoryState = new Map();
let marketGeneration = 0;
const compositeDisplayBatches=chartDisplayBatches({
  accept:acceptMarketBars,
  owners:key=>[...subscriptions.values()].filter(sub=>!sub.marketPaused && !sub.historical &&
    !sub.needsHistoryReload && !decode(sub.symbol).spec && indicatorKey(sub.symbol,sub.res)===key),
  settle:(key,current)=>indicatorCoordinator?.settle((ticker,res)=>indicatorKey(ticker,res)===key,current),
  report:(key,error,reload)=>{
    send({type:'feed-poll-state',key:'display:'+key,error:error ? String(error) : ''});
    if(reload)for(const sub of subscriptions.values())if(indicatorKey(sub.symbol,sub.res)===key){
      sub.needsHistoryReload=true;void recoverMarketBar(sub);
    }
  },
});

function mergeProviderAcceptance(previous,current) {
  const receipts=new Map((previous || []).map(row=>[row.start,row]));
  for(const row of current || [])receipts.set(row.start,row);
  return [...receipts.values()].sort((a,b)=>a.start-b.start).slice(-2048);
}
function acceptMarketBars(sub,event) {
  if(event.as_of!=null && event.as_of<(sub.displayAsOf ?? -Infinity))return;
  sub.displayAsOf=event.as_of ?? sub.displayAsOf;
  const identity=decode(sub.symbol);
  if(identity.spec?.name==='ROLLING_RANGE_SQUEEZE') publishSqueeze(MWSeries.encode(identity.symbol,identity.series_kind),sub.res,event);
  if(identity.spec?.name==='SWING_SR_V1') {
    if(!swingStore().publish(MWSeries.encode(identity.symbol,identity.series_kind),sub.res,event,swingStore().ticket()))return;
    swingDisplay?.refresh();
  }
  const rows=barsOf(event,sub.res,sub.symbol);
  const acceptedTimes=new Set();
  for(const bar of rows)if(bar.time>=sub.last){
    if(sub.cb({...bar}) === false)break;
    acceptedTimes.add(bar.time);
    observeRangeBars(sub.symbol,sub.res,event.bars,[bar],sub.window);sub.last=bar.time;
  }
  const acceptedStarts=new Set((event.bars || []).filter(bar=>
    acceptedTimes.has(bar.chart_time ?? stamp(bar,sub.res,identity.symbol))).map(bar=>bar.start));
  const receipts=(event.provider_acceptance || []).filter(row=>acceptedStarts.has(row.start));
  const state=marketHistoryState.get(sub.symbol+'|'+sub.res+'|'+(sub.window || ''));
  if(state){
    if(receipts.length)state.provider_acceptance=mergeProviderAcceptance(state.provider_acceptance,receipts);
    if(event.loaded_before!=null && acceptedTimes.size===rows.length)state.last=event.loaded_before;
    if(event.history_revision!=null)state.history_revision=event.history_revision;
    if(event.history_tail_revision!=null)state.history_tail_revision=event.history_tail_revision;
    if(event.initial_input_revision!=null)state.input_revision=event.initial_input_revision;
    if(event.display_snapshot_id!=null)state.display_snapshot_id=event.display_snapshot_id;
  }
  if(identity.series_kind==='provider' && receipts.length)send({type:'market-accept',args:{
    client:clientId,listener:sub.marketListener,generation:sub.marketGeneration,
    result_epoch:event.result_epoch,sequence:event.sequence,provider_acceptance:receipts}});
  rememberIndicatorBinding(sub.symbol,sub.res,event);
  if(event.pending?.length)send({type:'status',text:event.pending.join('；')});
  send({type:'feed-poll-state',key:sub.symbol+'|'+sub.res,error:event.status?.error || ''});
}

function quoteTimeText(stamp, meta) {
  if (!Number.isFinite(stamp)) return "";
  let timezone = "UTC";
  try {
    timezone = widget?.activeChart?.().getTimezoneApi?.().getTimezone?.().id || "UTC";
  } catch (_) {}
  if (timezone === "exchange") timezone = meta?.timezone || "UTC";
  try {
    const date = new Date(stamp);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false,
    }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    const value = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    const offset = new Intl.DateTimeFormat("en", {timeZone: timezone, timeZoneName:"longOffset"})
      .formatToParts(date).find(part => part.type === "timeZoneName")?.value || "GMT";
    const shortOffset = offset === "GMT" ? "UTC" : offset.replace(/^GMT/, "UTC")
      .replace(/UTC([+-])0?(\d{1,2}):00$/, "UTC$1$2");
    const zone = timezone === "UTC" || timezone === "Etc/UTC" ? "UTC" :
      timezone === "Asia/Shanghai" ? shortOffset : `${timezone} (${shortOffset})`;
    return `${value} ${zone}`;
  } catch (_) { return new Date(stamp).toISOString().replace("T", " ").replace(".000Z", " UTC"); }
}
function presentQuote(row) {
  const meta = presentationFor(row.n);
  const result = chartQuotePresentation(row, meta);
  const value = result.v && typeof result.v === "object" ? {...result.v} : result.v;
  if (value && typeof value === "object") {
    const base = value.description_base ?? String(value.description || "")
      .replace(/ · (?:最后更新于|最后行情时间|历史数据时间) .*?(?= · |$)/g, "")
      .replace(/ · 来源 M1 分钟数据/g, "");
    value.description = base;
    if (value.confirmation_error) value.description += " · 实时样本可用，分钟确认延迟";
    if (["pending", "stale"].includes(value.fetch_status))
      value.description += value.lp == null ? " · 等待首次报价" : " · 报价暂未更新，保留上次数据";
  }
  // Native details ignores the description on error rows. A resolved session
  // remains useful without a successful price; fetch_status carries the error.
  return {...result, s:result.s === "error" && value?.market_session ? "ok" : result.s, v: value};
}
function publishNotificationTimezone(zone, label) {
  globalThis.MWChartTime?.set(zone, label);
  if (alertUISession && alertUIWorkspace)
    send({type:"chart-timezone", zone, label, session:alertUISession, workspace_id:alertUIWorkspace});
}
function refreshNotificationTimezone() {
  let zone = "UTC", label = "UTC（图表初始化前）";
  try {
    if (ready && !loading && widget) {
      const chart = widget.activeChart();
      const id = chart.getTimezoneApi().getTimezone().id;
      zone = id;
      label = id;
      if (id === "exchange") {
        const meta = presentationFor(chart.symbol());
        // Match the timezone supplied to the chart datafeed exactly.
        zone = meta ? meta.timezone || (meta.calendar === "utc0" ? "Etc/UTC" : "America/New_York") : "UTC";
        label = meta ? `交易所 · ${zone}` : "UTC（交易所时区待解析）";
      }
    }
  } catch (_) { zone = "UTC"; label = "UTC（图表时区暂不可用）"; }
  publishNotificationTimezone(zone, label);
}
function refreshQuotePresentation() {
  refreshNotificationTimezone();
  if (typeof dataCenter !== "undefined") dataCenter?.refreshTimezone?.();
  for (const sub of quoteSubscriptions.values()) {
    const rows = sub.symbols.map(ticker => quoteSnapshotRows.get(ticker)).filter(Boolean);
    if (rows.length) sub.cb(rows.map(presentQuote));
  }
}
function bindTimezoneEvents() {
  if (!widget) return;
  for (const [api, changed] of timezoneBindings) api.onTimezoneChanged().unsubscribe(null, changed);
  timezoneBindings.clear();
  for (const [chart, changed] of timezoneSymbolBindings) chart.onSymbolChanged().unsubscribe(null, changed);
  timezoneSymbolBindings.clear();
  for (let index = 0; index < widget.chartsCount(); index++) {
    const api = widget.chart(index).getTimezoneApi?.();
    if (!api?.onTimezoneChanged) continue;
    const changed = () => refreshQuotePresentation();
    api.onTimezoneChanged().subscribe(null, changed);
    timezoneBindings.set(api, changed);
    const chart = widget.chart(index);
    chart.onSymbolChanged().subscribe(null, changed);
    timezoneSymbolBindings.set(chart, changed);
  }
  refreshNotificationTimezone();
}
const timezoneBindings = new Map();
const timezoneSymbolBindings = new Map();
let activeChartEventWidget;
function unbindActiveChartEvent() {
  if (!activeChartEventWidget) return;
  activeChartEventWidget.unsubscribe("activeChartChanged", refreshQuotePresentation);
  activeChartEventWidget = undefined;
}
function bindActiveChartEvent() {
  if (!widget?.subscribe) return;
  if (activeChartEventWidget === widget) return;
  unbindActiveChartEvent();
  widget.subscribe("activeChartChanged", refreshQuotePresentation);
  activeChartEventWidget = widget;
}

function marketQuery(ticker, res) {
  const identity = decode(ticker);
  return {instrument:identity.symbol, series_kind:identity.series_kind, timeframe:frames[res] || 'M1',
    ...(identity.spec ? {indicators:[{...identity.spec,
      calculation_origin:alertCalculationOrigins.get(MWSeries.encode(identity.symbol,identity.series_kind)+'|'+res) ?? null}]} : {}),
    ...(identity.series_kind === 'managed' ? {published:true,
      dataset_start:managedSessions.get(identity.symbol+'|'+res)?.start} : {})};
}
function registerMarketBar(sub) {
  if (marketPollingFallback || !sub.marketListener || sub.marketPaused) return;
  const state = marketHistoryState.get(sub.symbol+'|'+sub.res+'|'+(sub.window || '')) || {};
  sub.marketGeneration = ++marketGeneration;
  sub.marketSequence = 0;
  send({type:'market-subscribe',args:{client:clientId,listener:sub.marketListener,
    generation:sub.marketGeneration,kind:'bars',query:marketQuery(sub.symbol,sub.res),
    history_accepted:!!(state.accepted && !state.empty || sub.last),
    history_plot_width:datasetGeometry(sub.symbol,sub.res).plot_width,
    history_bar_spacing:datasetGeometry(sub.symbol,sub.res).bar_spacing,
    cursor:sub.last || 0,sequence:0,
    loaded_after:state.first ?? firstHistory.get(sub.symbol+'|'+sub.res) ?? null,
    loaded_before:state.last ?? sub.last ?? null,
    history_revision:state.history_revision ?? null,history_tail_revision:state.history_tail_revision ?? null,
    observed_at:state.observed_at || 0,
    provider_acceptance:state.provider_acceptance || [],
    dependency_origin:indicatorDependencyOrigins.get(indicatorKey(sub.symbol,sub.res)) ?? null,
    dependency_observed_at:state.dependency_observed_at ?? null,
    dependency_before:indicatorBindings.get(indicatorKey(sub.symbol,sub.res))?.dependencyBefore ?? null,
    dependency_revision:indicatorBindings.get(indicatorKey(sub.symbol,sub.res))?.dependencyRevision ?? null,
    binding:state.binding || null,initial_input_revision:state.input_revision ?? null,
    display_snapshot_id:state.display_snapshot_id ?? null,
    initial_indicator_pending:!!sub.initialIndicatorPending,historical:!!sub.historical}});
}
function rememberIndicatorBinding(ticker,res,page,{correction=false}={}) {
  if(decode(ticker).spec)return;
  const key=indicatorKey(ticker,res),old=indicatorBindings.get(key) || {};
  const provider=decode(ticker).series_kind==='provider';
  // Realtime fixed/managed bars do not expose a numeric cache revision. Track
  // the accepted last candle's actual input, not page-wide history hashes that
  // change with pagination or indicator preparation progress.
  const latest=(page.latest_bar ?? page.bars)?.reduce((last,bar)=>!last || bar.start>last.start ? bar : last,null);
  const hasTail=latest && latest.start>=(old.lastStart ?? -Infinity);
  const tailToken=hasTail ? JSON.stringify([latest.start,latest.open,latest.high,latest.low,latest.close,
    latest.complete,latest.revision,latest.volume,latest.volume_complete,latest.source_confirmed,latest.coverage_complete]) : old.tailToken;
  const tailChanged=hasTail && tailToken!==old.tailToken;
  let firstStart=old.firstStart,lastStart=old.lastStart;
  for(const bar of page.bars || []) {
    firstStart=Math.min(firstStart ?? Infinity,bar.start);
    lastStart=Math.max(lastStart ?? -Infinity,bar.start);
  }
  indicatorBindings.set(key,{...old,
    revision:page.revision_id ?? old.revision,
    inputRevision:page.input_revision ?? page.initial_input_revision ?? old.inputRevision,
    displaySnapshot:hasTail ? page.display_snapshot_id ?? old.displaySnapshot : old.displaySnapshot ?? page.display_snapshot_id,
    providerSnapshot:hasTail ? page.provider_snapshot_id ?? old.providerSnapshot : old.providerSnapshot ?? page.provider_snapshot_id,
    lastChartTime:hasTail ? latest.chart_time ?? latest.start : old.lastChartTime,
    // A main provider page's start follows the viewport. Only a Python result
    // may establish the calculation origin; later price pagination preserves it.
    calculationStart:provider && !page.indicators?.length ? old.calculationStart :
      page.calculation_origin ?? page.origin ?? old.calculationStart,
    tailVersion:page.cache_revision ?? page.revision ?? (tailChanged ? (old.tailVersion || 0)+1 : old.tailVersion ?? 0),
    tailToken,
    firstStart,lastStart,
    correctionVersion:correction ? (old.correctionVersion || 0)+1 : old.correctionVersion || 0,
    correctionStart:correction ? page.affected_chart_time : old.correctionStart,
  });
  void indicatorCoordinator?.sync();
}
// Facts originate at actual terminal attempts, never from React snapshots or error text.
function emitNotice(fault,recovered=false){
  send({type:'notice-source',workspace_id:alertUIWorkspace,session:alertUISession,epoch:workspaceEpoch,fault,recovered});
}
function capturePreferenceScope() {
  return {workspace_id:alertUIWorkspace,session:alertUISession,epoch:workspaceEpoch};
}
function reportPreferenceOutcome(error, context = {}, scope = capturePreferenceScope()) {
  if(scope.workspace_id!==alertUIWorkspace || scope.session!==alertUISession || scope.epoch!==workspaceEpoch)return;
  emitNotice({source_kind:'preferences',attempt_id:crypto.randomUUID(),code:'PREFERENCE_SAVE_FAILED',
    title:error ? '设置未保存' : '设置已保存',message:error ? String(error) : '偏好操作已成功',
    context:{source_id:JSON.stringify([context.kind || '',context.name || '',context.tool || '',context.operation || 'save']),
      consumer:'preferences-adapter',endpoint:'/advanced-charts/preferences'},
    evidence:{operation:context.operation || 'save',attempt_revision:context.revision ?? null,code:error?.code || null,http_status:error?.status || null}}, !error);
}
// Each live request owner carries at most one outage per instrument/period.
// Callers fence cancellation/generation before recording a transition.
function marketRequestNotice(owner,ticker,res,error,observationEnded=false){
  if(error?.code==='HISTORY_CANCELLED' || error?.name==='AbortError')return;
  const key=ticker+'|'+res;
  const outages=owner.noticeOutages || (owner.noticeOutages=new Map());
  let attempt=outages.get(key);
  if(error && !attempt){attempt=crypto.randomUUID();outages.set(key,attempt);}
  else if(error || !attempt)return;
  if(!error)outages.delete(key);
  emitNotice({source_kind:'market',attempt_id:attempt,code:'MARKET_REQUEST_FAILED',title:'图表行情请求失败',
    message:observationEnded ? '请求观察已结束，未确认恢复' : error ? String(error) : '当前有效行情请求已成功',
    ...(observationEnded ? {observation_ended:true} : {}),
    evidence:{operation:'initial_or_poll_request',error_type:error?.name||'',code:error?.code||'',http_status:error?.status||null},
    context:{instrument:ticker,timeframe:res,consumer:'request',source_id:owner.noticeSourceId || (owner.noticeSourceId=crypto.randomUUID())}},!error);
}
function endMarketRequestObservation(owner){
  for(const key of [...owner?.noticeOutages?.keys() || []]) {
    const split=key.lastIndexOf('|');
    marketRequestNotice(owner,key.slice(0,split),key.slice(split+1),null,true);
  }
}
function indicatorFault(consumer,error,attempt_id){
  const binding=indicatorBindings.get(indicatorKey(consumer.chart.symbol(),consumer.chart.resolution()))||{};
  const scope=MWNativeIndicatorResults.scope(consumer.chart,consumer.id);
  return {source_kind:'indicator',attempt_id:attempt_id||crypto.randomUUID(),code:'INDICATOR_TERMINAL_FAILED',
    title:'图格指标计算失败',message:String(error?.message||'当前可见范围已成功计算'),
    context:{chart_index:consumer.index,consumer:consumer.id,instrument:consumer.chart.symbol(),timeframe:consumer.chart.resolution()},
    evidence:{reason_code:error?.code||'INDICATOR_FAILED',params:consumer.params,algorithm_version:consumer.meta.version,
      input_revision:binding.inputRevision,visible_from:scope?.first,visible_to:scope?.last,
      calculation_origin:binding.calculationStart,accepted_scope:consumer.acceptedScope||null,
      ...(error?.dependency ? {dependency:error.dependency} : {})}};
}
function releaseIndicatorConsumers(consumers) {
  // Cancellation fences are cumulative. Merge only unsent releases for this
  // client; never mutate an in-flight request or omit a newer generation.
  const references=new Map();
  for(const consumer of consumers) {
    const old=references.get(consumer.id);
    if(!old || old.generation<consumer.generation)references.set(consumer.id,consumer);
  }
  const rows=[...references.values()];
  for(let offset=0;offset<rows.length;offset+=64) {
    const batch=rows.slice(offset,offset+64);
    const queued=requests.find(entry=>{
      if(entry.type!=='indicator-demand-release' || entry.query.client!==clientId)return false;
      const merged=new Map(entry.query.consumers.map(consumer=>[consumer.id,consumer]));
      for(const consumer of batch) {
        const old=merged.get(consumer.id);
        if(!old || old.generation<consumer.generation)merged.set(consumer.id,consumer);
      }
      if(merged.size>64)return false;
      entry.query.consumers=[...merged.values()];
      return true;
    });
    if(!queued)void request({client:clientId,consumers:batch},'indicator-demand-release').catch(()=>{});
  }
}
function startIndicatorCoordinator(catalog) {
  indicatorCoordinator=chartIndicatorCoordinator(widget,catalog,{
    read:(symbol,res,args,current)=>query(symbol,res,args,Date.now()+30000,current),
    recover:(ticker,res,token,error)=>recoverDisplaySnapshot(ticker,res,token,false,error?.snapshot_evidence),
    identity:{
      binding:(ticker,res)=>{
        const id=decode(ticker),key=indicatorKey(ticker,res),base=indicatorBindings.get(key);
        if(!base)return null;
        const session=managedSessions.get(id.symbol+'|'+res);
        return {...base,revision:base.revision || (id.series_kind==='history'?id.symbol:
          id.series_kind==='managed'?'published:'+String(session?.revision):'provider:'+id.symbol),
          calculationStart:base.calculationStart ?? session?.start ?? 0,
          inputPolicy:['history','composite'].includes(id.series_kind) ? 'observed_display_v1' : 'strict_confirmed_v1',
          before:Number.isFinite(base.lastChartTime ?? base.lastStart) ? (base.lastChartTime ?? base.lastStart)+1 : undefined,
          query:{...(base.revision && id.series_kind==='composite'?{composite_revision_id:base.revision}:{}),
            ...(['history','composite'].includes(id.series_kind)?{indicator_input_policy:'observed_display_v1'}:{}),
            ...(base.displaySnapshot && id.series_kind==='composite'?{display_snapshot_id:base.displaySnapshot}:{}),
            ...(base.providerSnapshot && id.series_kind==='provider'?{provider_snapshot_id:base.providerSnapshot}:{}),
            ...(id.series_kind==='provider' && base.calculationStart?{calculation_origin:base.calculationStart}:{}),
            ...(['managed','history','composite'].includes(id.series_kind) && base.firstStart>0 ? {dependency_before:base.firstStart}:{}),
            provisional:true}};
      },
      chartTime:(bar,res,ticker)=>stamp(bar,res,decode(ticker).symbol),
      remember:(ticker,res,page)=>{const old=indicatorBindings.get(indicatorKey(ticker,res));if(old)
        Object.assign(old,{calculationStart:page.calculation_origin ?? page.origin ?? old.calculationStart,
          dependencyBefore:page.dependency_before ?? old.dependencyBefore,
          dependencyRevision:page.dependency_revision ?? old.dependencyRevision});},
    },
    status:(consumer,state,error,quality)=>send({type:'chart-indicator-state',epoch:workspaceEpoch,index:consumer.index,
      id:consumer.id,name:consumer.meta.label || consumer.id,state,error:error?.message || '',
      quality,
      previousParams:MWNativeIndicatorResults.scope(consumer.chart,consumer.id)?.transition?.params || null}),
    occurrence:(error,consumer,attempt)=>{if(!['HISTORY_CANCELLED','DISPLAY_SNAPSHOT_EXPIRED'].includes(error.code))emitNotice(indicatorFault(consumer,error,attempt));},
    recovered:consumer=>emitNotice(indicatorFault(consumer),true),
    report:error=>{if(error.code!=='HISTORY_CANCELLED')send({type:'error',error:'指标读取失败：'+String(error)});},
    presentation:(ticker,res,page)=>{publishSqueeze(ticker,res,page);swingStore().publish(ticker,res,page,swingStore().ticket());swingDisplay?.refresh();},
    leases:leases=>{if(leases.length)void request({client:clientId,leases},'indicator-demand-update').catch(error=>send({type:'error',error:String(error)}));},
    release:releaseIndicatorConsumers,
    demand:rows=>{
      const next=new Map(rows.map(row=>[indicatorKey(row.ticker,row.resolution),row.origin]));
      const changed=new Set([...indicatorDependencyOrigins.keys(),...next.keys()].filter(key=>indicatorDependencyOrigins.get(key)!==next.get(key)));
      for(const row of rows)if(row.dependencyRevision)changed.add(indicatorKey(row.ticker,row.resolution));
      indicatorDependencyOrigins.clear();for(const [key,origin] of next)indicatorDependencyOrigins.set(key,origin);
      // This is per-consumer correction evidence on the existing price task.
      // It neither subscribes auxiliary plots nor computes indicators in SSE.
      for(const sub of subscriptions.values())if(!decode(sub.symbol).spec && changed.has(indicatorKey(sub.symbol,sub.res)))registerMarketBar(sub);
    },
  });
}
function providerRecoveryRows(chart) {
  if(!chart.dataReady())return null;
  const data=chart._chartWidget.model().model().mainSeries().data(),rows=[];
  if(data.size()<1 || data.size()>20000)return null;
  // Native stops iteration when the callback returns a truthy value.
  data.each((_,row)=>{rows.push(row.slice(0,6));});
  return rows.length===data.size() ? rows : null;
}
async function refreshProviderDisplayCredential(ticker,res,token,charts,current,evidence={}) {
  const key=indicatorKey(ticker,res),binding=indicatorBindings.get(key);
  if(!binding || binding.providerSnapshot!==token){evidence.refresh_reason='binding_superseded';return false;}
  const accepted=charts.map(({chart})=>({chart,rows:providerRecoveryRows(chart)}));
  if(accepted.some(item=>!item.rows)){evidence.refresh_reason='native_rows_unavailable';return false;}
  let refreshed;
  for(const {rows} of accepted) {
    const page=await query(ticker,res,{before:rows.at(-1)[0]*1000+1,
      limit:rows.length,indicators:[]},Date.now()+10000,current);
    if(!current())return false;
    // A stream update can already have replaced the rejected credential.
    if(indicatorBindings.get(key)?.providerSnapshot!==token){evidence.refresh_reason='credential_superseded';return true;}
    if(!page.provider_snapshot_id || !Number.isSafeInteger(page.cache_revision) ||
      page.cache_revision!==binding.tailVersion){evidence.refresh_reason='credential_or_revision_changed';return false;}
    const prices=barsOf(page,res,ticker);
    if(prices.length!==rows.length || prices.some((bar,index)=>{
      const row=rows[index];
      return bar.time!==row[0]*1000 || ['open','high','low','close'].some((name,i)=>bar[name]!==row[i+1]) ||
        (bar.volume ?? 0)!==(row[5] ?? 0);
    })){evidence.refresh_reason='price_rows_changed';return false;}
    if(!refreshed || prices.at(-1).time>=barsOf(refreshed,res,ticker).at(-1).time)refreshed=page;
  }
  if(!current())return false;
  if(indicatorBindings.get(key)?.providerSnapshot!==token){evidence.refresh_reason='credential_superseded';return true;}
  // Pagination, navigation or a native restart during the read invalidates the
  // comparison. No credential may be rebound under a different accepted page.
  if(accepted.some(({chart,rows})=>JSON.stringify(providerRecoveryRows(chart))!==JSON.stringify(rows))){evidence.refresh_reason='native_rows_changed';return false;}
  rememberIndicatorBinding(ticker,res,refreshed);
  evidence.refresh_reason='compared_equal';
  return true;
}
const displayRecoveries=new Map();
function resumeDeferredDisplayRecoveries(){
  for(const entry of displayRecoveries.values()){
    entry.prune();
    if(entry.state==='deferred')entry.resume?.();
  }
}
async function recoverDisplaySnapshot(ticker,res,token,retry=false,failureEvidence={}){
  const key=indicatorKey(ticker,res),previous=displayRecoveries.get(key);
  const binding=indicatorBindings.get(key);
  const boundToken=binding?.displaySnapshot ?? binding?.providerSnapshot;
  if(boundToken!=null && boundToken!==token)return;
  // Reading unchanged prices can renew the same content-addressed token. A
  // later expiry needs a new recovery; delayed errors for replaced tokens do not.
  const expiredAgain=previous?.state==='ready';
  if(previous?.token===token && !expiredAgain && (!retry || previous.state!=='error'))return previous.promise;
  const epoch=workspaceEpoch;
  const charts=ready ? Array.from({length:widget.chartsCount()},(_,index)=>({index,chart:widget.chart(index)}))
    .filter(({chart})=>chartUsesSymbol(chart,ticker,res)) : [];
  const trace=(phase,reason)=>{
    entry.evidence={...entry.evidence,reload_phase:phase,reload_reason:reason,reload_starts:entry.attempts};
    if(phase==='cancelled')entry.evidence.cancel_reason=reason;
    console.info('display-snapshot-recovery',JSON.stringify(entry.evidence));
  };
  const entry={token,attempt_id:crypto.randomUUID(),state:'preparing',attempts:0,evidence:{},prune(){
    for(let offset=charts.length-1;offset>=0;offset--){
      const {index,chart}=charts[offset];
      if(epoch===workspaceEpoch && index<widget.chartsCount() &&
          (widget.chart(index)._chartWidget || widget.chart(index))===(chart._chartWidget || chart) && chartUsesSymbol(chart,ticker,res))continue;
      charts.splice(offset,1);
      if(epoch===workspaceEpoch)send({type:'chart-indicator-state',epoch,index,id:'display-snapshot:'+key,name:'行情快照',state:'removed',error:''});
    }
    if(!charts.length && displayRecoveries.get(key)===entry){
      entry.state='cancelled';trace('cancelled',epoch===workspaceEpoch ? 'viewer_removed' : 'stale_native_generation');entry.resume?.();
      displayRecoveries.delete(key);send({type:'feed-poll-state',key:'display:'+key,error:''});
    }
  }};
  const current=()=>epoch===workspaceEpoch && displayRecoveries.get(key)===entry && ready &&
    charts.some(({index,chart})=>index<widget.chartsCount() && (widget.chart(index)._chartWidget || widget.chart(index))===(chart._chartWidget || chart) && chartUsesSymbol(chart,ticker,res));
  const notify=(state,error='')=>{for(const {index,chart} of charts)
    if(index<widget.chartsCount() && (widget.chart(index)._chartWidget || widget.chart(index))===(chart._chartWidget || chart) && (state==='removed' || chartUsesSymbol(chart,ticker,res)))
      send({type:'chart-indicator-state',epoch,index,id:'display-snapshot:'+key,name:'行情快照',state,error});};
  previous?.resume?.();
  displayRecoveries.set(key,entry);
  entry.evidence={attempt_ref:entry.attempt_id,native_generation:epoch,refresh_reason:'not_attempted',reload_starts:0};
  entry.promise=(async()=>{
    if(!current())return;
    const hash=await crypto.subtle.digest('SHA-256',Uint8Array.from(token,character=>character.charCodeAt(0)));
    entry.evidence={...entry.evidence,credential_ref:Array.from(new Uint8Array(hash)).slice(0,8).map(n=>n.toString(16).padStart(2,'0')).join(''),
      snapshot_reason:failureEvidence?.reason || 'unknown',rejected_attempt_ref:failureEvidence?.attempt_ref || null,
      native_generation:epoch,refresh_reason:'not_attempted',reload_starts:0};
    if(!current())return;
    notify('preparing');
    // Failed native resets can leave old model rows after detaching the source.
    // Explicit retry must restart it; unchanged prices alone cannot restore it.
    if(ticker.startsWith('MWP:') && !(retry && previous?.state==='error')) {
      try {
        if(await refreshProviderDisplayCredential(ticker,res,token,charts,current,entry.evidence)) {
          trace('restored',entry.evidence.refresh_reason);
          if(current()) {
            entry.state='ready';notify('ready');emitNotice({source_kind:'indicator',attempt_id:entry.attempt_id,code:'SNAPSHOT_RECOVERY_FAILED',title:'图表快照已恢复',message:'当前有效图格已成功恢复',context:{instrument:ticker,timeframe:res,consumer:'snapshot'}},true);send({type:'feed-poll-state',key:'display:'+key,error:''});
          }
          return;
        }
      } catch(error) {
        if(!current())return;
        entry.evidence.refresh_reason='comparison_request_failed';
        // A failed comparison read cannot certify unchanged prices. Retain
        // the existing bounded full recovery and its visible retry state.
      }
    }
    if(!current())return;
    compositeDisplayBatches.cancel(key);
    for(const sub of subscriptions.values())if(indicatorKey(sub.symbol,sub.res)===key){
      sub.needsHistoryReload=true;
      sub.marketGeneration=++marketGeneration;sub.marketSequence=0;
    }
    cache.clear();
    while(entry.attempts<3 && current()){
      try{
        const result=await reloadHistory(ticker,res,chart=>current() && charts.some(item=>(item.chart._chartWidget || item.chart)===(chart._chartWidget || chart)),true);
        if(!current())return;
        if(result.status==='deferred'){
          entry.state='deferred';trace('deferred',result.reason);
          await new Promise(resolve=>{entry.resume=()=>{entry.resume=null;resolve();};});
          if(!current())return;
          const active=indicatorBindings.get(key),activeToken=active?.displaySnapshot ?? active?.providerSnapshot;
          if(activeToken!=null && activeToken!==token){entry.state='cancelled';trace('cancelled','credential_superseded');return;}
          entry.state='preparing';continue;
        }
        if(result.status==='cancelled'){entry.state='cancelled';trace('cancelled',result.reason);return;}
        entry.attempts++;trace(result.status,result.reason);
        if(result.status==='restored'){
          for(const sub of subscriptions.values())if(indicatorKey(sub.symbol,sub.res)===key){
            sub.needsHistoryReload=false;registerMarketBar(sub);
          }
          entry.state='ready';notify('ready');emitNotice({source_kind:'indicator',attempt_id:entry.attempt_id,code:'SNAPSHOT_RECOVERY_FAILED',title:'图表快照已恢复',message:'当前有效图格已成功恢复',context:{instrument:ticker,timeframe:res,consumer:'snapshot'}},true);send({type:'feed-poll-state',key:'display:'+key,error:''});
          return;
        }
      }catch(error){
        if(!current())return;
        entry.attempts++;trace('failed','reload_exception');
        if(entry.attempts===3)throw error;
      }
      if(entry.attempts<3)await new Promise(resolve=>setTimeout(resolve,1000*2**(entry.attempts-1)));
    }
    if(current())throw Error('展示快照恢复失败，请重试指标');
  })();
  const cancel=()=>{if(!current()){
    if(entry.state!=='cancelled'){entry.state='cancelled';trace('cancelled',epoch!==workspaceEpoch ? 'stale_native_generation' : displayRecoveries.get(key)!==entry ? 'recovery_superseded' : 'viewer_removed');}
    if(displayRecoveries.get(key)===entry){displayRecoveries.delete(key);if(epoch===workspaceEpoch)notify('removed');}
  }};
  entry.promise.then(cancel,error=>{if(current()){
    error.code='SNAPSHOT_RECOVERY_FAILED';error.dependency={code:'SNAPSHOT_RECOVERY_FAILED',attempt_ref:entry.attempt_id,...entry.evidence};
    entry.state='error';notify('error',String(error));
    emitNotice({source_kind:'indicator',attempt_id:entry.attempt_id,code:'SNAPSHOT_RECOVERY_FAILED',title:'图表快照恢复失败',message:String(error),context:{instrument:ticker,timeframe:res,consumer:'snapshot'},evidence:{...entry.evidence,input_revision:binding?.inputRevision,calculation_origin:binding?.calculationStart}});
    send({type:'feed-poll-state',key:'display:'+key,error:String(error)});
  }else cancel();});
  if(displayRecoveries.size>64){
    const oldest=displayRecoveries.keys().next().value;displayRecoveries.get(oldest).resume?.();displayRecoveries.delete(oldest);
  }
  return entry.promise;
}
function acceptMarketHistory(ticker,res,page,window = '', acceptedRows) {
  rememberIndicatorBinding(ticker,res,page);
  if(marketPollingFallback) return;
  const key=ticker+'|'+res+'|'+(window || ''), old=marketHistoryState.get(key) || {};
  const acceptedTimes=acceptedRows && new Set(acceptedRows.map(bar=>bar.time));
  const bars=(page.bars || []).filter(bar=>!acceptedTimes ||
    acceptedTimes.has(bar.chart_time ?? stamp(bar,res,decode(ticker).symbol)));
  if(!bars.length && old.accepted && !old.empty) return;
  const acceptedStarts=new Set(bars.map(bar=>bar.start));
  marketHistoryState.set(key,{first:bars.length ? Math.min(old.first ?? Infinity,bars[0].start) : null,
    accepted:true,empty:!bars.length,
    last:bars.length ? Math.max(old.last || 0,bars.at(-1).start) : null,observed_at:page.as_of || Date.now(),
    provider_acceptance:mergeProviderAcceptance(old.provider_acceptance,
      (page.provider_acceptance || []).filter(row=>acceptedStarts.has(row.start))),
    input_revision:page.input_revision ?? null,
    display_snapshot_id:page.display_snapshot_id ?? old.display_snapshot_id,
    binding:page.revision_id || null,history_revision:page.history_check?.next_revision || null,
    dependency_observed_at:old.dependency_observed_at ?? null,
    history_tail_revision:page.history_check?.next_tail_revision || null});
  for(const sub of subscriptions.values()) if(sub.symbol===ticker && sub.res===res && (sub.window || '')===(window || '')) {
    const historyKey=ticker+'|'+res+(decode(ticker).series_kind==='provider' ? '|'+(window || '') : '');
    sub.last=Math.max(sub.last || 0,lastHistory.get(historyKey) || 0);
    if(!sub.marketRecovering && !sub.needsHistoryReload) registerMarketBar(sub);
  }
}
async function recoverMarketBar(sub) {
  if(sub.marketRecovering || ![...subscriptions.values()].includes(sub)) return;
  sub.marketRecovering=true;
  try {
    const restored=await reloadHistory(sub.symbol,sub.res,chart=>!sub.window || providerWindowMatches(chart,sub));
    if(![...subscriptions.values()].includes(sub)) return;
    if(restored) {
      sub.needsHistoryReload=false;
      marketRequestNotice(sub,sub.symbol,sub.res,null);
      registerMarketBar(sub);
    } else sub.marketRetry=setTimeout(()=>recoverMarketBar(sub),500);
  } catch(error) {
    if(![...subscriptions.values()].includes(sub))return;
    marketRequestNotice(sub,sub.symbol,sub.res,error);
    send({type:'feed-poll-state',key:sub.symbol+'|'+sub.res,error:String(error)});
    if([...subscriptions.values()].includes(sub)) sub.marketRetry=setTimeout(()=>recoverMarketBar(sub),1000);
  } finally {sub.marketRecovering=false;}
}
function synchronizeMarketVisibility() {
  resumeDeferredDisplayRecoveries();
  if(marketPollingFallback || !ready || loading) return;
  for(const sub of subscriptions.values()) {
    if(!sub.marketListener) continue;
    const visible=hasHistoryViewer({instrument:sub.symbol,timeframe:frames[sub.res]});
    if(!visible && !sub.marketPaused) {
      compositeDisplayBatches.cancel(indicatorKey(sub.symbol,sub.res));
      sub.marketPaused=true;
      clearTimeout(sub.marketRetry);
      send({type:'market-unsubscribe',args:{client:clientId,listener:sub.marketListener,generation:sub.marketGeneration}});
    } else if(visible && sub.marketPaused) {
      sub.marketPaused=false;
      sub.needsHistoryReload=true;
      void recoverMarketBar(sub);
    }
  }
}
const symbolPresentations = new Map();
const quoteSnapshotRows = new Map();
const quoteResetTokens = new Map();
function quoteReadState(row) {
  const status = row.v?.fetch_status;
  if (row.s === "error" || status && !["ok", "pending", "stale"].includes(status)) return "failed";
  return ["pending", "stale"].includes(status) ? "waiting" : "healthy";
}
function presentationFor(ticker) {
  const exact = symbolPresentations.get(ticker) ||
    watchlistMetadata.get(ticker) || watchlistMetadata.get(ticker.toLowerCase());
  if (exact) return exact;
  try { return symbolPresentations.get(decode(ticker).symbol); } catch (_) { return undefined; }
}
function rememberQuoteRows(rows) {
  for (const row of rows || []) {
    if (!row?.n) continue;
    const previous = quoteSnapshotRows.get(row.n);
    // The subscription generation handles identity changes; read time fences
    // delayed initial snapshots from overwriting a newer stream observation.
    if (previous?.v?.read_at != null && row.v?.read_at != null && row.v.read_at < previous.v.read_at) continue;
    const failed = quoteReadState(row) !== "healthy";
    const sameBinding = ["revision_id", "input_revision", "source_identity"].every(key =>
      row.v?.[key] == null || JSON.stringify(row.v[key]) === JSON.stringify(previous?.v?.[key]));
    if (failed && row.v?.lp == null && previous?.v?.lp != null && sameBinding) {
      const value = {...previous.v, fetch_status: row.v?.fetch_status || "fetch_failed"};
      for (const key of ["wait_reason", "last_success_at", "cache_age_ms"])
        if (Object.hasOwn(row.v || {}, key)) value[key] = row.v[key];
      for (const key of ["market_session", "session_reason", "session_conflict_reason", "calendar_verified", "calendar_version"])
        if (Object.hasOwn(row.v || {}, key)) value[key] = row.v[key];
      quoteSnapshotRows.set(row.n, {...previous, v: value});
      continue;
    }
    quoteSnapshotRows.set(row.n, row);
  }
  while (quoteSnapshotRows.size > 250)
    quoteSnapshotRows.delete(quoteSnapshotRows.keys().next().value);
}
function quoteFailureRows(symbols, initialRows) {
  const failed = [];
  for (const ticker of symbols) {
    const previous = quoteSnapshotRows.get(ticker);
    if (initialRows && previous !== initialRows.get(ticker)) continue;
    const placeholder = previous ? null : seriesPresentationRows([ticker])[0];
    const value = previous?.v || placeholder?.v || {description_base: ticker, market_session: "unknown"};
    // Preserve the bound observation and its read time. Failure is a transport
    // state, not a newer price; a successful same-time snapshot can recover it.
    const row = {s: previous?.s || "ok", n: ticker, v: {...value, fetch_status: "fetch_failed"}};
    quoteSnapshotRows.set(ticker, row);
    failed.push(row);
  }
  return failed.map(presentQuote);
}
const alertSourceMetadata = new Map();
// Native resolve callbacks also serve watchlists. Only matching chart targets
// own visible recovery state; every completion retains its original lifetime.
const chartResolves = new Map();
let resolveDisposed = false, resolveGeneration = 0;
function resolveCharts(ticker) {
  if (!widget || resolveDisposed) return [];
  const targets=[];
  try {
    for(let index=0;index<widget.chartsCount();index++) {
      try {
        const chart=widget.chart(index);
        // Layout restore exposes chart APIs before their models attach. Read
        // both accessors together; one incomplete peer must not block resolve.
        if(MWSeries.same(chart.symbol(),ticker))
          targets.push({chart,index,resolution:chart.resolution()});
      } catch { /* This chart is still attaching or has already detached. */ }
    }
  } catch { /* The widget itself may be disposing. */ }
  return targets;
}
const resolveChartKey = chart => chart._chartWidget || chart;
function resolveCurrent(target) {
  return !resolveDisposed && target.epoch===workspaceEpoch && chartResolves.get(resolveChartKey(target.chart))===target &&
    resolveCharts(target.symbol).some(({chart,resolution})=>resolveChartKey(chart)===resolveChartKey(target.chart) && resolution===target.resolution);
}
function reportResolveStates() {
  const states=[];
  for (const [chart,target] of chartResolves) {
    if (!resolveCurrent(target)) {chartResolves.delete(chart);continue;}
    if (target.state!=='ready') states.push({index:target.index,symbol:target.symbol,resolution:target.resolution,
      generation:target.generation,state:target.state,message:target.message,code:target.code,
      retryable:target.retryable,retryAt:target.retryAt});
  }
  send({type:'chart-resolve-states',epoch:workspaceEpoch,states});
}
function beginResolve(ticker) {
  const targets=resolveCharts(ticker).map(({chart,index,resolution})=>{
    const previous=chartResolves.get(resolveChartKey(chart));
    // The library can resolve one symbol for several chart/watchlist consumers
    // concurrently. They share the chart lifetime instead of cancelling each
    // other's legitimate callback. A completed/failed attempt gets a new one.
    if(previous?.state==='loading' && resolveCurrent(previous)) return previous;
    return {chart,index,symbol:ticker,resolution,
      epoch:workspaceEpoch,generation:++resolveGeneration,state:'loading',message:'正在解析行情身份，完成后可创建告警',retryable:false,retryAt:0};
  });
  for (const target of targets) chartResolves.set(resolveChartKey(target.chart),target);
  if(targets.length) reportResolveStates();
  const epoch=workspaceEpoch;
  return {targets,current:()=>!resolveDisposed && epoch===workspaceEpoch && (!targets.length || targets.some(resolveCurrent))};
}
const alertCalculationOrigins = new Map();
const lastHistory = new Map();
const providerHistoryState = new Map();
const providerHistoryWork = new Map();
const firstHistory = new Map();
const fixedHistoryStarts = new Map();
const coldHistory = new Set();
const refreshingHistoryRanges = new Map();
const pendingHistory = new Map();
const indicatorHistoryNeeds = new Map();
const failedHistory = new Map();
let retryDialogOpen = false;
function rememberHistoryFailure(args, state) {
  if (state.failed_task_ids?.length)
    failedHistory.set(JSON.stringify(args), {
      args,
      ids: state.failed_task_ids,
    });
}
function offerHistoryRetry() {
  if (!ready || retryDialogOpen) return;
  for (const [key, entry] of failedHistory) {
    failedHistory.delete(key);
    if (!hasHistoryViewer(entry.args)) continue;
    retryDialogOpen = true;
    widget.showConfirmDialog({
      title: "历史行情拉取失败",
      body: entry.args.instrument + " 的历史任务已停止。是否重新尝试？",
      callback: async (confirmed) => {
        try {
          if (!confirmed || !hasHistoryViewer(entry.args)) return;
          for (const id of new Set(entry.ids))
            await request({ op: "retry", args: { id } }, "market");
          pendingHistory.set(key, entry.args);
          send({ type: "status", text: "已重新安排历史拉取" });
        } catch (e) {
          send({ type: "error", error: String(e) });
        } finally {
          retryDialogOpen = false;
        }
      },
    });
    break;
  }
}
const clientId = crypto.randomUUID();
const requests = [];
let initialHistoryGate;
const managementRequest = type => type === 'data-center-api' || type === 'preferences';
// Local scheduling purpose is independent of transport/body/cache identity.
// Keep admission and fairness here rather than adding exceptions at callers.
const requestPolicy = (() => {
  let turn = 0;
  let nativeAvailable = 4;
  const nativeDispatches = new Set();
  function describe(entry) {
    const query=entry.query;
    const management=managementRequest(entry.type);
    const reserve=!!query.native_reserve || entry.scheduling?.purpose==='reserve';
    const purpose=management ? 'management' : reserve ? 'reserve' :
      query.indicators?.length ? 'indicator' : entry.scheduling?.purpose ||
      (entry.type==='indicator-demand-release' ? 'release' : entry.type==='indicator-demand-update' ? 'renewal' : query.op==='quotes' ? 'quote' :
        query.op==='viewport' || query.op==='historyCache' && !query.background || entry.type==='workspace' ? 'interaction' :
        query.op==='historyCache' && query.background ? 'auxiliary' :
        query.firstDataRequest ? 'first-screen' : 'read');
    return {management,reserve,quote:query.op==='quotes',
      nativeHistory:entry.type==='data' && query.series_kind==='provider' && !!query.native_history && !query.native_reserve,
      background:['reserve','release','renewal','quote','auxiliary'].includes(purpose),purpose};
  }
  function priority(entry) {
    const {purpose,background}=describe(entry);
    if(purpose==='interaction') return 0;
    if(['first-screen','navigation'].includes(purpose))
      return entry.scheduling?.focused?.() ? 1 : 2;
    return background ? 4 : 3;
  }
  function next(queued, running) {
    const entries=[...running.values()];
    const managementBusy=entries.filter(entry=>entry.management).length;
    const management=queued.findIndex(entry=>managementRequest(entry.type));
    if(management>=0 && managementBusy<2) return management;
    if(entries.length-managementBusy>=4) return -1;
    const backgroundBusy=entries.filter(entry=>entry.background).length;
    const quoteBusy=entries.some(entry=>entry.quote);
    const eligible=[];
    for(let index=0;index<queued.length;index++) {
      const entry=describe(queued[index]);
      if(!entry.management && (!entry.background || backgroundBusy<2) && (!entry.quote || !quoteBusy) &&
        (!entry.nativeHistory || nativeAvailable>nativeDispatches.size))
        eligible.push(index);
    }
    if(!eligible.length) return -1;
    // One FIFO turn in four prevents a stream of focused reads from starving
    // peers, indicators or background work. Eligibility preserves hard caps.
    const selected=turn===3 ? eligible[0] : eligible.reduce((best,index)=>
      priority(queued[index])<priority(queued[best]) ? index : best);
    turn=(turn+1)%4;
    return selected;
  }
  function capacity(available, id) {
    if(!Number.isInteger(available) || available<0 || available>4) return;
    if(id!==undefined) nativeDispatches.delete(id);
    nativeAvailable=available;
  }
  function dispatched(id, entry) {
    if(describe(entry).nativeHistory) nativeDispatches.add(id);
  }
  return {describe,next,capacity,dispatched,completed:id=>nativeDispatches.delete(id)};
})();
function discardObsoleteRequests() {
  // A stale quote/indicator request must release its queued place even while
  // its execution lane is busy. Admission cannot wait for it to be selected.
  for(let index=requests.length-1;index>=0;index--) {
    const entry=requests[index];
    if(entry.isCurrent && !entry.isCurrent()) {
      requests.splice(index,1);
      entry.reject(Object.assign(Error("已取消旧图表的历史加载"),{code:"HISTORY_CANCELLED"}));
    }
  }
}
function drain() {
  discardObsoleteRequests();
  while (requests.length) {
    const selectedIndex=requestPolicy.next(requests,pending);
    if (selectedIndex < 0) break;
    const selected=requests.splice(selectedIndex,1)[0];
    const {query,type,resolve,reject,isCurrent}=selected;
    if (isCurrent && !isCurrent()) {
      const error = Error("已取消旧图表的历史加载");
      error.code = "HISTORY_CANCELLED";
      reject(error);
      continue;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      send({type:"cancel-request",id});
      reject(Object.assign(Error("行情请求超时"),{code:"HISTORY_TIMEOUT"}));
      drain();
    }, query.native_history && !query.native_reserve ? ((globalThis.MW_HISTORY_CAPABILITIES?.task_seconds || 600)+10)*1000 : 30000);
    const entry = {resolve,reject,timer,cancellationTimer:null,...requestPolicy.describe(selected)};
    pending.set(id, entry);
    if (isCurrent) {
      const check = () => {
        if (!pending.has(id)) return;
        if (isCurrent()) {
          entry.cancellationTimer = setTimeout(check, 100);
          return;
        }
        pending.delete(id);
        clearTimeout(timer);
        send({ type: "cancel-request", id });
        const error = Error("已取消旧图表的历史加载");
        error.code = "HISTORY_CANCELLED";
        reject(error);
        drain();
      };
      entry.cancellationTimer = setTimeout(check, 100);
    }
    requestPolicy.dispatched(id,selected);
    send({ type, id, query, ...(entry.nativeHistory ? {history_client:clientId} : {}) });
  }
}
function request(query, type = "data", isCurrent, scheduling) {
  return new Promise((resolve, reject) => {
    if (requests.length >= 64) discardObsoleteRequests();
    if (requests.length >= 64) return reject(Error("图表请求过多，请减少指标"));
    requests.push({query,type,resolve,reject,isCurrent,scheduling});
    drain();
  });
}
function dateAt(ms, zone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
function stamp(bar, res, symbol) {
  if (!["1D", "1W", "1M"].includes(res)) return bar.start;
  const zone = symbol === "BTCUSDT" ? "Etc/UTC" : "America/New_York";
  // Daily timestamps are trading-date labels at UTC midnight, not session opens.
  let date = dateAt(
    res === "1D"
      ? bar.end - 1
      : bar.start + (symbol === "BTCUSDT" ? 0 : 86400000),
    zone,
  );
  if (res === "1M") date = date.slice(0, 7) + "-01";
  return Date.parse(date + "T00:00:00Z");
}
function decode(symbol) {
  return MWSeries.decode(symbol);
}
function barsOf(result, res, ticker) {
  const { symbol, spec, key } = decode(ticker);
  if (!spec)
    return result.bars.map((b) => ({
      time: b.chart_time ?? stamp(b, res, symbol),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      ...(b.volume !== null && b.volume !== undefined && Number.isFinite(Number(b.volume)) && Number(b.volume) >= 0
        ? { volume: Number(b.volume) } : {}),
    }));
  const values = new Map(
    (result.indicators[0]?.series.find((s) => s.key === key)?.values || []).map(
      (v) => [v.time, v],
    ),
  );
  return result.bars.map((b) => {
    const point = values.get(b.start), v = point?.value;
    return {
      time: b.chart_time ?? stamp(b, res, symbol),
      open: v ?? 0,
      high: v ?? 0,
      low: v ?? 0,
      close: v ?? 0,
      // 2 retains a valid numeric value and marks a true data gap for profiles
      // that must break even with period=1 (which has no warmup null).
      volume: v !== null && v !== undefined ? (point.break_before ? 2 : 1) : 0,
    };
  });
}
function observeRangeBars(symbol, resolution, bars, accepted, window = '', ticket) {
  if (!barRangeMapping || decode(symbol).spec) return;
  const times = new Set(accepted.map(bar => bar.time));
  barRangeMapping.observeBars({symbol, resolution, window, ticket,
    bars: bars.filter(bar => times.has(bar.chart_time ?? stamp(bar,resolution,decode(symbol).symbol)))
      .map(bar => ({...bar,chart_time:bar.chart_time ?? stamp(bar,resolution,decode(symbol).symbol)}))});
}
const managedSessions = new Map();
const fixedIndicatorPending = new Map();
const alertCompositeRevisions = new Map();
const maintenanceAsked = new Set();
const cache = new Map();
function datasetGeometry(ticker, res) {
  const matches = widget ? Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i))
    .filter(chart=>chartUsesSymbol(chart,ticker,res)) : [];
  // The shared datafeed has no pane identifier. Use the largest real plotting
  // capacity among matching panes; every matching pane gets enough history.
  const sizes = matches.map(chart=>({plot_width:chart.getTimeScale().width(),
    bar_spacing:chart.getTimeScale().barSpacing()})).filter(x=>x.plot_width>0 && x.bar_spacing>0);
  return sizes.sort((a,b)=>b.plot_width/b.bar_spacing-a.plot_width/a.bar_spacing)[0] ||
    {plot_width:960,bar_spacing:6};
}

function nativeHistoryContext(ticker, res) {
  try {
    const count = widget.chartsCount();
    if (!Number.isInteger(count) || count < 1 || count > 8)
      throw Error('Unknown chart count');
    const active = widget.activeChart();
    const context = {chart_count:count, focused:chartUsesSymbol(active,ticker,res),
      historical_navigation:false};
    if (globalThis.MWNativeReserve?.enabled()) {
      const g = datasetGeometry(ticker, res), screen = Math.min(2000, Math.ceil(g.plot_width / g.bar_spacing));
      Object.assign(context, {screen_bars:screen,
        batch_screens:MWNativeReserve.extra({ticker},res) > screen ? 2 : 1});
    }
    return context;
  } catch (_) {
    return {chart_count:8,focused:null,historical_navigation:false};
  }
}

function nativeReserveWarmup(symbol, resolution) {
  let prefix = 0;
  if (!widget) return prefix;
  for (let i=0;i<widget.chartsCount();i++) {
    const chart=widget.chart(i); if(!chartUsesSymbol(chart,symbol,resolution)) continue;
    for (const study of chart.getAllStudies()) {
      const api=chart.getStudyById(study.id), values=new Map(api.getInputValues().map(v=>[v.id,v.value]));
      for(const input of api.getInputsInfo()) {
        const value=values.get(input.id);
        if(/length|period/i.test(input.name) && Number.isInteger(value) && value>0)
          prefix=Math.max(prefix,Math.min(2000,value));
      }
    }
  }
  return prefix;
}
globalThis.MWNativeReserve?.configure(async ({symbol, resolution, before, screen_bars, batch_screens, warmup_bars, window, current=()=>true}) => {
  const rangeTicket = barRangeMapping?.capture(symbol,resolution,window);
  if(['history','composite'].includes(decode(symbol).series_kind)) {
    const identity=decode(symbol);
    const stateKey=MWSeries.encode(identity.symbol,identity.series_kind)+'|'+resolution+'|'+(window || '');
    const acceptedState=marketHistoryState.get(stateKey);
    const binding=acceptedState?.binding;
    const inputRevision=acceptedState?.input_revision;
    const page=await query(symbol,resolution,{before,limit:Math.min(2000,screen_bars*batch_screens),
      ...(binding ? {composite_revision_id:binding,input_revision:inputRevision} : {})},Date.now()+30000,current,{purpose:'reserve'});
    const latest=marketHistoryState.get(stateKey);
    if(!current() || binding && (latest?.binding!==binding || latest?.input_revision!==inputRevision))
      throw Object.assign(Error('已取消旧图表的历史加载'),{code:'HISTORY_CANCELLED'});
    const rows=barsOf(page,resolution,symbol);
    return {...page,bars:rows,history_boundary:page.has_more===false && !page.pending?.length,
      accepted:()=>observeRangeBars(symbol,resolution,page.bars,rows,window,rangeTicket)};
  }
  const page = await query(symbol, resolution, {
    before, limit: screen_bars * batch_screens, countBack: screen_bars * batch_screens,
    client: clientId, native_history: nativeHistoryContext(symbol, resolution),
    native_reserve: {screen_bars, batch_screens, warmup_bars},
  },Infinity,current);
  // An old API silently ignores optional fields. Never feed its unbounded
  // mandatory result into the reserve lane or mistake an empty miss for EOD.
  if (!['ready', 'partial', 'miss'].includes(page.reserve_status))
    throw Error('后端尚不支持图表储备协议');
  if (historyOlder(page, providerHistoryState.get(symbol+'|'+resolution)))
    throw Error('已丢弃旧版本的图表储备响应');
  return {...page, bars: barsOf(page, resolution, symbol),
    accepted: () => observeRangeBars(symbol,resolution,page.bars,barsOf(page,resolution,symbol),window,rangeTicket)};
}, nativeReserveWarmup);
globalThis.MWNativeNavigation?.configure(nativeReserveWarmup);

globalThis.addEventListener('mw-history-occurrence',({detail})=>{
  if(!ready||loading)return;
  const charts=Array.from({length:widget.chartsCount()},(_,index)=>({index,chart:widget.chart(index)}));
  for(const {index,chart}of charts)if(chartUsesSymbol(chart,detail.instrument,detail.timeframe))emitNotice({
    source_kind:detail.source_kind,attempt_id:detail.attempt_id+':'+index,code:detail.code,title:detail.source_kind==='capacity'?'图格历史容量受限':'图格历史读取失败',
    message:detail.message,context:{chart_index:index,instrument:detail.instrument,timeframe:detail.timeframe},evidence:detail.evidence},detail.recovered===true);
});
globalThis.addEventListener('mw-navigation-error', event => {
  if (event.detail?.code === 'NATIVE_HISTORY_CAPACITY_EXCEEDED')
    send({type:'capacity-notice',epoch:workspaceEpoch,key:'operation',phase:'failed',message:String(event.detail)});
  else if (event.detail?.code !== 'HISTORY_CANCELLED') send({type:'error',error:String(event.detail)});
});
globalThis.addEventListener('mw-capacity-state', event =>
  send({type:'capacity-notice',epoch:workspaceEpoch,...event.detail}));
function reportHistoryFailures() {
  if(!ready || loading) return;
  const failures=[];
  for(let index=0;index<widget.chartsCount();index++) {
    const chart=widget.chart(index),error=MWNativeNavigation.failure(chart);
    if(error) failures.push({index,symbol:chart.symbol(),resolution:chart.resolution(),
      label:alertSourceMetadata.get(chart.symbol())?.display_symbol || chart.symbol(),error:String(error)});
  }
  send({type:'chart-history-failures',epoch:workspaceEpoch,failures});
}
globalThis.addEventListener('mw-history-state',()=>{setTimeout(reportHistoryFailures,0);resumeDeferredDisplayRecoveries();});

function query(ticker, res, args, expires = Infinity, current = () => true, scheduling = {}) {
  const { symbol, spec, series_kind } = decode(ticker);
  const q = {
    instrument: symbol,
    series_kind,
    ...(['composite','history'].includes(series_kind) || args.indicators?.length ? {client:clientId} : {}),
    timeframe: frames[res],
    ...(spec && series_kind === 'provider' && alertCalculationOrigins.has(MWSeries.encode(symbol,series_kind)+'|'+res)
      ? {calculation_origin:alertCalculationOrigins.get(MWSeries.encode(symbol,series_kind)+'|'+res)} : {}),
    ...(series_kind === 'managed' ? {published:true,
      ...(managedSessions.get(symbol+'|'+res)?.start != null
        ? {dataset_start:managedSessions.get(symbol+'|'+res).start} : {})} : {}),
    ...args,
    ...(spec ? { indicators: [spec] } : {}),
    ...(spec && ['history','composite'].includes(series_kind) ? {indicator_input_policy:'observed_display_v1'} : {}),
  };
  const key = JSON.stringify(q);
  const old = cache.get(key);
  if (!q.indicators?.length && (series_kind === 'managed' || spec) && old && Date.now() - old.time < 1000) return old.promise;
  const epoch = workspaceEpoch;
  const squeezeTicket = spec?.name==='ROLLING_RANGE_SQUEEZE' ? squeezeStore().ticket() : null;
  const swingTicket = spec?.name==='SWING_SR_V1' ? swingStore().ticket() : null;
  // Native owns the lifetime of its period caches. A temporary period switch
  // does not cancel a getBars callback that it can reuse when switching back.
  const currentRead = () => epoch === workspaceEpoch && current() && Date.now() < expires &&
    (series_kind !== 'managed' || hasHistoryViewer({instrument:MWSeries.encode(symbol,series_kind),timeframe:frames[res]}));
  const promise = request(q, "data", currentRead, {purpose:scheduling.purpose,focused:()=>{
    try {
      const active=widget?.activeChart?.();
      return !!active && MWSeries.same(active.symbol(),ticker) && active.resolution()===res;
    } catch { return false; }
  }})
    .then(page=>{
      if (!currentRead()) throw Object.assign(Error('已取消旧图表的历史加载'), {code:'HISTORY_CANCELLED'});
      if(epoch===workspaceEpoch && series_kind==='composite' && page.revision_id)
        alertCompositeRevisions.set(MWSeries.encode(symbol,series_kind)+'|'+res,page.revision_id);
      if (epoch===workspaceEpoch && spec && Number.isSafeInteger(page.calculation_origin ?? page.origin))
        alertCalculationOrigins.set(MWSeries.encode(symbol,series_kind)+'|'+res,page.calculation_origin ?? page.origin);
      if(epoch===workspaceEpoch && spec?.name==='ROLLING_RANGE_SQUEEZE') publishSqueeze(MWSeries.encode(symbol,series_kind),res,page,squeezeTicket);
      if(epoch===workspaceEpoch && spec?.name==='SWING_SR_V1') {
        swingStore().publish(MWSeries.encode(symbol,series_kind),res,page,swingTicket);
        swingDisplay?.refresh();
      }
      return page;
    })
    .catch(error=>{
      if(epoch===workspaceEpoch && error.code==='DISPLAY_SNAPSHOT_EXPIRED' && q.display_snapshot_id && !q.indicators?.length)
        void recoverDisplaySnapshot(ticker,res,q.display_snapshot_id);
      if(epoch===workspaceEpoch && Date.now()>=expires)
        throw Object.assign(Error('历史复核时间预算已耗尽'), {code:'HISTORY_TIMEOUT'});
      throw error;
    });
  if (!q.indicators?.length && (series_kind === 'managed' || spec)) cache.set(key, { time: Date.now(), promise });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return promise;
}
// Share only in-flight planning reads; completed results must be polled fresh.
const historyRequests = new Map();
function historyQuery(args) {
  const epoch = workspaceEpoch;
  const key = JSON.stringify([
    epoch,
    args.instrument,
    args.timeframe,
    args.before,
    args.limit,
  ]);
  const existing = historyRequests.get(key);
  if (existing) return existing;
  const promise = request(
    { op: "history", args },
    "market",
    () => epoch === workspaceEpoch && hasHistoryViewer(args),
  );
  historyRequests.set(key, promise);
  const remove = () => {
    if (historyRequests.get(key) === promise) historyRequests.delete(key);
  };
  promise.then(remove, remove);
  return promise;
}
function seriesPresentationRows(symbols) {
  return symbols.flatMap(ticker => {
    const identity = decode(ticker);
    const meta = presentationFor(ticker);
    const shown = meta?.display_symbol || meta?.symbol || MWSeries.display(identity.symbol);
    const base = meta?.source === 'yahoo' ? (meta.name || shown) + " · Yahoo 市场报价" +
      (meta.delay_seconds > 0 ? " · 延迟 " + Math.floor(meta.delay_seconds / 60) + " 分钟" :
        meta.delay_seconds === 0 ? " · 实时" : " · 延迟未知") :
      identity.series_kind === 'provider' ? shown + " · 平台行情" + (meta?.price_description ? " · " + meta.price_description : "") :
      identity.series_kind === 'history' ? (meta?.name || shown) + " · 固定历史" :
      identity.series_kind === 'composite' ? (meta?.name || shown) + " · 组合行情" : shown + " · 自建行情";
    return meta ? [{s:"ok",n:ticker,v:{short_name:shown,description:base,description_base:base,
      market_session:"unknown",time_type:identity.series_kind === "history" ? "fixed_history" : null,
      exchange:meta.exchange || meta.source?.toUpperCase()}}].map(presentQuote) : [];
  });
}
// Vendor start counts returned rows; backend cursors count qualified candidates.
// Keep that translation local to each immutable query, with bounded memory.
const nativeSearchPages = new Map();
async function searchNativeSymbols(options) {
  const epoch = workspaceEpoch;
  const kind = options.kind || "all";
  const key = JSON.stringify([kind,options.userInput,options.exchange,options.symbolType,epoch]);
  const start = options.start || 0;
  let pages = nativeSearchPages.get(key);
  if (!pages || start === 0) {pages=new Map([[0,null]]);nativeSearchPages.set(key,pages);}
  while(nativeSearchPages.size>20) nativeSearchPages.delete(nativeSearchPages.keys().next().value);
  if (!pages.has(start)) throw Error("搜索分页已失效，请重新搜索");
  let position=pages.get(start),page;
  for(let scan=0;scan<5;scan++) {
    page=await request({op:"searchPage",args:{kind,query:options.userInput || "",page_size:50,
      source:options.exchange ? options.exchange.toLowerCase() : undefined,
      symbol_type:options.symbolType || "",...(kind === "all" ? {cursor:position || undefined} : {offset:position || 0})}},"market",()=>epoch===workspaceEpoch && !options.signal?.aborted);
    position=kind === "all" ? page.next_cursor : page.next_offset;
    if(page.items.length || position == null) break;
  }
  if(epoch!==workspaceEpoch) throw Error("工作区已切换");
  if(position != null) pages.set(start+page.items.length,position);
  while(pages.size>256) pages.delete(pages.keys().next().value);
  return {items:page.items.map(s=>({symbol:s.display_symbol || s.symbol,ticker:s.ticker,
    description:s.label+" · "+s.description,exchange:s.source === "composite" ? (s.historical_source || "").toUpperCase() : s.source.toUpperCase(),
    type:s.type || "other"})),remaining:position != null ? 1 : 0};
}

// Share outstanding snapshots, not completed quote data. Each consumer keeps
// its own callback/reset fence and cannot cancel another live consumer.
const quoteRequests = new Map();
function readQuoteSnapshot(symbols, isCurrent) {
  const epoch=workspaceEpoch, batch=[...new Set(symbols)].sort();
  const key=JSON.stringify([epoch,batch]);
  let entry=quoteRequests.get(key);
  if(!entry || !entry.current() || !batch.every(ticker=>
    entry.tokens.get(ticker)===quoteResetTokens.get(ticker))) {
    const consumers=new Set([isCurrent]);
    entry={consumers,initialRows:new Map(batch.map(ticker=>[ticker,quoteSnapshotRows.get(ticker)])),
      tokens:new Map(batch.map(ticker=>[ticker,quoteResetTokens.get(ticker)])),
      current:()=>epoch===workspaceEpoch && [...consumers].some(current=>current())};
    const shared=entry;
    shared.promise=request({op:'quotes',args:{symbols:batch}},'market',shared.current)
      .finally(()=>{if(quoteRequests.get(key)===shared)quoteRequests.delete(key);});
    quoteRequests.set(key,shared);
  } else entry.consumers.add(isCurrent);
  const shared=entry;
  // A later consumer must not make this earlier HTTP operation own a newer
  // stream observation, even when the response has no distinct read time.
  return {initialRows:shared.initialRows,
    promise:shared.promise.finally(()=>shared.consumers.delete(isCurrent))};
}

const feed = {
  // The native price-axis countdown requires server time in UNIX seconds.
  // Authenticated/network access stays in the trusted parent origin.
  getServerTime: (cb) => request({op: "serverTime"}, "market")
    .then(cb).catch(error => send({type: "error", error: "服务器时间获取失败：" + String(error)})),
  getQuotes: (symbols, cb, err, isCurrent = () => true, forceRefresh = false) => {
    if (!symbols.length) {
      queueMicrotask(() => cb([]));
      return;
    }
    const epoch = workspaceEpoch;
    const initialRows = new Map(symbols.map(ticker => [ticker, quoteSnapshotRows.get(ticker)]));
    const resetTokens = new Map(symbols.map(ticker => [ticker, quoteResetTokens.get(ticker)]));
    const currentSymbols = () => symbols.filter(ticker => quoteResetTokens.get(ticker) === resetTokens.get(ticker));
    // Native details asks for an initial snapshot before it subscribes. An
    // already subscribed observation must not queue behind a slow mixed-source
    // refresh on every row click. Subscription refreshes still use the network.
    const subscribed = new Set([...quoteSubscriptions.values()].flatMap(sub => sub.symbols));
    if (!forceRefresh && !marketPollingFallback && symbols.every(ticker =>
      subscribed.has(ticker) && Number.isFinite(initialRows.get(ticker)?.v?.lp))) {
      setTimeout(() => {
        if (epoch !== workspaceEpoch || !isCurrent()) return;
        const rows = symbols.map(ticker => quoteSnapshotRows.get(ticker));
        if (currentSymbols().length === symbols.length && rows.every(row => Number.isFinite(row?.v?.lp)))
          cb(rows.map(presentQuote));
        else feed.getQuotes(symbols, cb, err, isCurrent, true);
      }, 0);
      return;
    }
    // Quotes are independent of chart history. The request queue still keeps
    // a bounded quote lane, while cancellation and epoch checks fence stale
    // callbacks when a workspace or list changes.
    const snapshot=readQuoteSnapshot(symbols, () => epoch === workspaceEpoch && isCurrent() && currentSymbols().length>0);
    snapshot.promise
      .then((rows) => {
        if (epoch !== workspaceEpoch || !isCurrent()) return;
        // A stream/reset received while this request was outstanding owns the
        // current selection, including its composite revision and identity.
        const active = currentSymbols();
        if (!active.length) return;
        rememberQuoteRows(rows.filter(row => active.includes(row.n) && quoteSnapshotRows.get(row.n) === snapshot.initialRows.get(row.n)));
        cb(active.map(ticker => quoteSnapshotRows.get(ticker)).filter(Boolean).map(presentQuote));
      })
      .catch((e) => {
        if (epoch !== workspaceEpoch || !isCurrent()) return;
        const active = currentSymbols();
        if (!active.length) return;
        const rows = quoteFailureRows(active, snapshot.initialRows);
        if (rows.length) cb(rows);
        err(String(e));
      });
  },
  subscribeQuotes: (symbols, fastSymbols, cb, id) => {
    feed.unsubscribeQuotes(id);
    const all=[...new Set([...symbols, ...fastSymbols])];
    const quoteSub={symbols:all,cb,listeners:[],lastRows:[]};
    quoteSubscriptions.set(id, quoteSub);
    rememberQuoteRows([]);
    if(!marketPollingFallback) for(const ticker of all) {
      const listener=crypto.randomUUID(),generation=++marketGeneration;
      quoteSub.listeners.push({listener,generation,ticker,sequence:0});
      send({type:'market-subscribe',args:{client:clientId,listener,generation,
        kind:'quotes',query:marketQuery(ticker,'1'),sequence:0}});
    }
    // The same name/quote path covers every supplier and series kind. Opaque
    // DUKA/NATIVE/MD identities need their human names just as fixed histories
    // and composites do; this must not depend on the active chart's resolve.
    const presented=all;
    if(presented.length) {
      // Give native details its resolved human name while the real market
      // snapshot loads. No price, change or quote time is invented here.
      setTimeout(()=>{
        if(quoteSubscriptions.get(id) !== quoteSub) return;
        // Selecting another row rebuilds native subscriptions. Do not replace
        // an existing price/session with name-only metadata. Read at delivery
        // time so a stream arrival or revision reset before this task wins.
        const rows=presented.flatMap(ticker=>{
          const snapshot=quoteSnapshotRows.get(ticker);
          return snapshot ? [presentQuote(snapshot)] : seriesPresentationRows([ticker]);
        });
        if(rows.length) cb(rows);
      },0);
      feed.getQuotes(presented,rows=>{
        if(quoteSubscriptions.get(id) !== quoteSub) return;
        // Keep the first snapshot beside streaming/polling rows so a timezone
        // or active-chart change can reformat the same stored epoch without
        // issuing another provider request.
        for(const row of rows) {
          const state=quoteReadState(row), failed=state==='failed';
          // Shared supplier failures belong to the server task. A failed HTTP
          // snapshot request remains local and can recover from a good SSE row.
          if(state !== 'waiting' && (!failed || marketPollingFallback))
            marketRequestNotice(quoteSub,row.n,'quotes',failed ? Error('报价抓取失败') : null);
        }
        cb(rows);
      },
        error=>{if(quoteSubscriptions.get(id)!==quoteSub)return;for(const ticker of presented)marketRequestNotice(quoteSub,ticker,'quotes',error);send({type:"feed-poll-state",key:"@quotes",error:String(error)});},
        () => quoteSubscriptions.get(id) === quoteSub, true);
    }
  },
  unsubscribeQuotes: (id) => {
    endMarketRequestObservation(quoteSubscriptions.get(id));
    for(const entry of quoteSubscriptions.get(id)?.listeners || [])
      send({type:'market-unsubscribe',args:{client:clientId,listener:entry.listener,generation:entry.generation}});
    quoteSubscriptions.delete(id);
  },
  onReady: (cb) =>
    setTimeout(
      () =>
        cb({
          exchanges: [{value:"",name:"全部来源",desc:"全部行情来源"},
            ...["Dukascopy","OANDA","Binance","Yahoo"].map(name=>({value:name.toUpperCase(),name,desc:name+" 行情来源"}))],
          symbols_types: [{name:"全部",value:""},{name:"外汇",value:"forex"},{name:"股票",value:"stock"},
            {name:"加密",value:"crypto"},{name:"指数",value:"index"},{name:"基金",value:"fund"},
            {name:"期货",value:"futures"},{name:"金属",value:"commodity"},{name:"其他",value:"other"}],
          supported_resolutions: resolutions,
          supports_marks: false,
          supports_timescale_marks: false,
          supports_time: true,
        }),
      0,
    ),
  searchSymbols: (input, exchange, type, cb) => {
    searchNativeSymbols({userInput:input,exchange,symbolType:type,start:0})
      .then(page=>cb(page.items)).catch(error=>{cb([]);send({type:"error",error:String(error)});});
  },
  searchSymbolsPaginated: (options, cb) => {
    searchNativeSymbols(options).then(page=>cb(page.items,page.remaining))
      .catch(error=>{cb([],0);send({type:"error",error:String(error)});});
  },
  resolveSymbol: async (ticker, cb, err) => {
    const operation=beginResolve(ticker);
    try {
      const {symbol,series_kind} = decode(ticker);
      // One-time startup metadata rides with workspace configuration. Candle
      // demand and every subsequent symbol resolve still use the backend.
      const supplied = initialSymbol?.ticker === ticker ? initialSymbol.metadata :
        watchlistMetadata.get(ticker) || watchlistMetadata.get(ticker.toLowerCase());
      if (initialSymbol?.ticker === ticker) initialSymbol = undefined;
      if (supplied) {
        // Native datafeed callbacks must leave the calling task, even when
        // their payload arrived with the workspace configuration.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const meta = supplied || await request(
        { op: "resolve", args: { instrument: symbol, series_kind, timeframe: "M1" } },
        "market", operation.current,
      );
      if(!operation.current()) throw Object.assign(Error("已取消旧图表的行情解析"),{code:"HISTORY_CANCELLED"});
      for(const target of operation.targets) if(resolveCurrent(target)) target.state="ready";
      if(operation.targets.length) reportResolveStates();
      alertSourceMetadata.set(MWSeries.encode(symbol,series_kind),meta);
      while(alertSourceMetadata.size>250) alertSourceMetadata.delete(alertSourceMetadata.keys().next().value);
      // Quote descriptions are reformatted when the active chart timezone
      // changes. Keep every resolved source's timezone metadata available,
      // including managed OANDA/Binance instruments.
      symbolPresentations.set(ticker,meta);
      if (!symbolPresentations.has(symbol)) symbolPresentations.set(symbol,meta);
      while(symbolPresentations.size>250) symbolPresentations.delete(symbolPresentations.keys().next().value);
      watchlistLayout?.refresh();
      refreshNotificationTimezone();
      cb({
        name: meta.display_symbol || meta.symbol || MWSeries.display(symbol),
        ticker,
        // Informational estimate only; actual pagination remains backend-owned.
        mw_historyPageBars: meta.native_page_capacity || (meta.source === "binance" ? 1000 : 4000),
        description: (meta.source === "yahoo" ? meta.name + " · " + (meta.display_symbol || meta.symbol) : meta.display_symbol || meta.symbol || MWSeries.display(symbol)) + (series_kind === "provider" ? " · 平台行情 · " : series_kind === "composite" ? " · 组合行情 · " : " · 自建行情 · ") + (meta.price_description || meta.basis) + (meta.volume_kind === "tick" ? " · OANDA 报价量" : meta.volume_kind === "base" ? " · 成交量 / " + meta.volume_unit : meta.volume_kind === "quantity" ? " · 来源量" : " · 量不可用"),
        exchange: meta.exchange || meta.source.toUpperCase(),
        listed_exchange: meta.exchange || meta.source.toUpperCase(),
        mw_range_source: meta.source,
        ...(meta.source === "yahoo" ? { mw_display_precision: meta.display_precision } : {}),
        type: ({CRYPTO:"crypto", METAL:"commodity", INDEX:"index", ETF:"fund", EQUITY:"stock", FUTURE:"futures", OTHER:"commodity"})[meta.asset_type] || (meta.calendar === "utc0" ? "crypto" : "forex"),
        session: meta.session || (meta.source === "yahoo" ? "0000-0000:23456" : meta.calendar === "utc0" ? "24x7" : "1700-1700:23456"),
        timezone: meta.timezone || (meta.calendar === "utc0" ? "Etc/UTC" : "America/New_York"),
        minmov: 1,
        pricescale: 10 ** meta.precision,
        has_intraday: true,
        intraday_multipliers: meta.frames ? meta.frames.filter(f => !["D1","W1","MN"].includes(f)).map(f=>Object.keys(frames).find(r=>frames[r]===f)) : ["1", "5", "15", "30", "60", "240"],
        has_daily: true,
        daily_multipliers: ["1"],
        has_weekly_and_monthly: true,
        weekly_multipliers: ["1"],
        monthly_multipliers: ["1"],
        supported_resolutions: meta.frames ? resolutions.filter(r=>meta.frames.includes(frames[r])) : resolutions,
        // Synthetic study feeds always carry the null/gap marker in volume.
        visible_plots_set: decode(ticker).spec || meta.volume_kind && meta.volume_kind !== "unavailable" ? "ohlcv" : "ohlc",
        volume_precision: meta.volume_kind === "tick" ? 0 : 8,
        format: "price",
        data_status: meta.delay_seconds > 0 ? "delayed_streaming" : "streaming",
        ...(meta.delay_seconds > 0 ? {delay:meta.delay_seconds} : {}),
        ...(meta.currency ? {currency_code:meta.currency} : {}),
        has_empty_bars: false,
      });
      // The library keeps the old interval on a source switch even if the
      // newly resolved symbol excludes it. Use its public chart method.
      if(meta.source === "yahoo") setTimeout(()=>{
        for(const target of operation.targets) {
          if(resolveCurrent(target) && !meta.frames.includes(frames[target.resolution]))
            target.chart.setResolution("60",{doNotActivateChart:true});
        }
      },0);
    } catch (e) {
      if(operation.current()) {
        for(const target of operation.targets) if(resolveCurrent(target)) Object.assign(target,{state:'error',
          message:typeof e.message==='string'?e.message:'行情身份解析失败，请重试',code:e.code || 'RESOLVE_FAILED',
          retryable:e.retryable===true,retryAt:Date.now()+Math.max(0,Number(e.retryAfter)||0)*1000});
        if(operation.targets.length) reportResolveStates();
      }
      err(e.message || '行情身份解析失败');
      // The library also resolves watchlist entries. Its error callback marks
      // an unavailable entry (or chart symbol) at the requesting surface;
      // escalating it to a workspace modal blocks unrelated valid charts.
    }
  },
  getBars: async (s, res, p, cb, err) => {
    const loadEpoch=workspaceEpoch;
    let marketHistoryPage;
    const loadId=crypto.randomUUID();
    const rangeTicket=barRangeMapping?.capture(s.ticker,res,s.mw_window);
    const historyKey=s.ticker+'|'+res;
    const workKey=historyKey+'|'+(s.mw_window || '');
    const isProvider=decode(s.ticker).series_kind==='provider';
    if(isProvider) send({type:'native-load-start',id:loadId,epoch:loadEpoch,
      instrument:decode(s.ticker).symbol,timeframe:frames[res],
      count:p.countBack,from:p.from*1000,to:p.to*1000,
      boundaryId:p.mw_boundaryId,batch:p.mw_boundaryBatch,
      estimatedPages:Math.ceil(p.countBack/(s.mw_historyPageBars || 4000))});
    const providerWork=isProvider ? (providerHistoryWork.get(workKey) ||
      {symbol:s.ticker,res,window:s.mw_window,inflight:0,generation:0,correction:null,reloading:false}) : null;
    if(providerWork) {
      providerHistoryWork.set(workKey,providerWork);
      providerWork.inflight++;
    }
    let historyDeadline=Date.now()+8000;
    const completeTerminal=rangeGuard?.captureTerminalCompletion?.(
      chart=>chart.symbol()===s.ticker && chart.resolution()===res &&
        (globalThis.MWNativeNavigation?.chartWindow(chart)?.id || '') === (s.mw_window || ''));
    const finishTerminal=()=>{
      // Empty/error loads may never emit native dataReady. Finish only the
      // captured public loading token after the native callback has returned.
      if(completeTerminal) setTimeout(()=>{
        if(loadEpoch===workspaceEpoch) completeTerminal();
      },0);
    };
    try {
      beforeInitialHistory?.();
      if (!frames[res]) throw Error("不支持的周期");
      if(decode(s.ticker).symbol.startsWith("YAHOO:") && s.supported_resolutions && !s.supported_resolutions.includes(res)) {
        cb([],{noData:false});
        return;
      }
      if (decode(s.ticker).series_kind === "provider") {
        // Native requirements pass unchanged; the backend owns cache policy
        // and provider pagination, including demands larger than one page.
        const epoch = workspaceEpoch, reserveStarted = globalThis.performance?.now() || 0;
        const args={limit:p.countBack,history_progress_id:loadId,history_progress_epoch:loadEpoch,notice_chart_index:s.mw_window || '',
          history_page_bars:s.mw_historyPageBars || 4000,
          countBack:p.countBack, from:p.from*1000, before:p.to*1000,
          firstDataRequest:p.firstDataRequest, client:clientId,
          native_history:nativeHistoryContext(s.ticker,res)};
        let page = globalThis.MWNativeNavigation?.takeSeed(s, res, p) ||
          await query(s.ticker, res, args, Infinity, () => (!s.mw_current || s.mw_current()) && (!s.mw_window || MWNativeNavigation.hasWindow(s.mw_window)),
            {purpose:p.firstDataRequest ? 'first-screen' : 'navigation'});
        if (epoch !== workspaceEpoch) {
          const error = Error("已取消旧图表的历史加载");
          error.code = "HISTORY_CANCELLED"; throw error;
        }
        historyDeadline=Date.now()+30000;
        const seen=providerHistoryState.get(historyKey);
        const older=historyOlder(page,seen);
        if(older && page.bars?.length) {
          const generation=++providerWork.generation;
          // Exactly one review of this late response. Keep its callback valid
          // even on failure or a v1.3.2 response without a review result.
          const observation={revision:page.cache_revision||0,observed_at:page.as_of||0,
            first:page.bars[0].chart_time,last:page.bars.at(-1).chart_time};
          try {
            if(Date.now()>=historyDeadline) throw Object.assign(Error('历史复核时间预算已耗尽'), {code:'HISTORY_TIMEOUT'});
            const reviewed=await query(s.ticker,res,{...args,history_observation:observation},historyDeadline);
            if(epoch!==workspaceEpoch) throw Object.assign(Error('已取消旧图表的历史加载'),{code:'HISTORY_CANCELLED'});
            if(!reviewed.history_revalidation) throw Error('后端未提供历史复核结果');
            page=reviewed;
            const superseded=historyOlder(reviewed,providerHistoryState.get(historyKey));
            if(reviewed.history_revalidation.changed || superseded)
              mergeProviderCorrection(providerWork,generation,reviewed.history_revalidation.changed===true,
                {args,observation});
            if(superseded)
              send({type:'error',error:'历史复核期间出现新版本，请点击刷新历史完成检查'});
          } catch(error) {
            if(error.code==='HISTORY_CANCELLED') throw error;
            mergeProviderCorrection(providerWork,generation,false,{args,observation});
            send({type:'error',error:'历史复核未完成，请点击刷新历史：'+String(error)});
          }
        }
        const rows = barsOf(page, res, s.ticker);
        if(providerWork && page.bars?.length) {
          const old=providerWork.observation;
          providerWork.observation={
            first:Math.min(old?.first ?? Infinity,page.history_dependency_first ?? page.bars[0].chart_time),
            last:Math.max(old?.last ?? 0,page.bars.at(-1).chart_time),
            revision:Math.min(old?.revision ?? Infinity,page.cache_revision||0),
            observed_at:Math.min(old?.observed_at ?? Infinity,page.as_of||0),
          };
        }
        if(!historyOlder(page,providerHistoryState.get(historyKey))) {
          const previous=providerHistoryState.get(historyKey);
          providerHistoryState.set(historyKey,{revision:page.cache_revision||0,
            observed_at:page.as_of||0,cursor:Math.max(previous?.cursor||0,rows.at(-1)?.time||0)});
        }
        const boundary = page.has_more === undefined
          ? page.history_boundary === true || page.window_limit === true
          : page.has_more === false;
        if(page.window_limit) send({type:'feed-poll-state',key:s.ticker,
          error:'已到 Yahoo 当前可获取窗口边界，早期已缓存历史仍可查看'});
        if(decode(s.ticker).symbol.startsWith("YAHOO:") && rows.some(bar=>Math.min(bar.open,bar.high,bar.low,bar.close)<=0)) {
          for(let index=0; index<widget.chartsCount(); index++) {
            const chart=widget.chart(index);
            if(MWSeries.same(chart.symbol(),s.ticker)) chart.getPanes()[0]?.getMainSourcePriceScale()?.setMode(0);
          }
        }
        send({type:'native-load-applying',id:loadId,epoch:loadEpoch,count:rows.length});
        const accepted = cb(rows,{noData:boundary,mw_historyPages:page.history_pages || 0}) !== false;
        if (accepted && rows.length) {
          const key = workKey;
          lastHistory.set(key,Math.max(lastHistory.get(key)||0,rows.at(-1).time));
          firstHistory.set(key,Math.min(firstHistory.get(key)??Infinity,rows[0].time));
        }
        if (accepted) {observeRangeBars(s.ticker,res,page.bars,rows,s.mw_window,rangeTicket); acceptMarketHistory(s.ticker,res,page,s.mw_window,rows);}
        if (globalThis.MWNativeReserve)
          requestAnimationFrame(() => MWNativeReserve.delivered(s, res, performance.now() - reserveStarted));
        if(!rows.length) finishTerminal();
        return;
      }
      const identity = decode(s.ticker), symbol=identity.symbol;
      if (['history','composite'].includes(identity.series_kind)) {
        const epoch = workspaceEpoch;
        const current = () => epoch === workspaceEpoch && (!s.mw_current || s.mw_current());
        const requested = Math.max(1, Math.ceil(p.countBack));
        if (!Number.isSafeInteger(requested)) throw Error('无效历史根数');
        const capabilities=globalThis.MW_HISTORY_CAPABILITIES;
        const deadline=Date.now()+(capabilities?.task_seconds || 600)*1000;
        const pageBudget=capabilities?.task_pages || 300;
        const reserveStarted=globalThis.performance?.now() || 0;
        let before=p.to*1000 + (['1D','1W','1M'].includes(res) ? 2*86400000 : 0);
        const acceptedSnapshot=indicatorBindings.get(indicatorKey(s.ticker,res));
        let rows=[], rawRows=[], boundary=false, fixed=identity.series_kind==='composite' &&
          !p.firstDataRequest && acceptedSnapshot?.displaySnapshot &&
          ![...subscriptions.values()].some(sub=>sub.needsHistoryReload && indicatorKey(sub.symbol,sub.res)===indicatorKey(s.ticker,res)) ?
          {composite_revision_id:acceptedSnapshot.revision,display_snapshot_id:acceptedSnapshot.displaySnapshot} : {};
        for (let partition=0; rows.length<requested; partition++) {
          if(partition>=pageBudget) throw Object.assign(Error('固定历史分页预算已耗尽，请缩小范围后重试'),{code:'HISTORY_PAGE_BUDGET'});
          const page=await query(s.ticker,res,{before,limit:Math.min(2000,requested-rows.length),...fixed},deadline,current,
            {purpose:p.firstDataRequest ? 'first-screen' : 'navigation'});
          if (!current()) throw Object.assign(Error('已取消旧图表的历史加载'), {code:'HISTORY_CANCELLED'});
          marketHistoryPage ||= page;
          if (identity.spec) fixedIndicatorPending.set(historyKey,
            page.indicator_progress?.some(item=>item.status!=='complete') || false);
          if(page.bars?.length)
            fixedHistoryStarts.set(historyKey,Math.min(fixedHistoryStarts.get(historyKey)??Infinity,page.bars[0].start));
          rawRows.push(...page.bars);
          rows=barsOf(page,res,s.ticker).filter(bar=>bar.time<p.to*1000).concat(rows);
          if (page.revision_id) fixed={composite_revision_id:page.revision_id,
            ...(page.display_snapshot_id ? {display_snapshot_id:page.display_snapshot_id} : {input_revision:page.input_revision})};
          boundary=page.has_more===false && !page.pending?.length;
          if (page.pending?.length) {
            send({type:'status',text:page.pending.join('；')});
            // Indicator initialization is asynchronous; retain pagination and
            // let subscription review redraw as immutable output progresses.
            if (!identity.spec || !page.indicator_progress?.length) {
              boundary=false; break;
            }
          }
          if (boundary) break;
          const next=page.next_before;
          if (!(next<before)) throw Error('固定行情分页未推进');
          before=next;
        }
        rows=[...new Map(rows.map(bar=>[bar.time,bar])).values()].sort((a,b)=>a.time-b.time);
        const accepted = cb(rows,{noData:boundary}) !== false;
        if(accepted && rows.length) {
          firstHistory.set(historyKey,Math.min(firstHistory.get(historyKey)??Infinity,rows[0].time));
          lastHistory.set(historyKey,Math.max(lastHistory.get(historyKey)||0,rows.at(-1).time));
        }
        if (accepted) {observeRangeBars(s.ticker,res,rawRows,rows,s.mw_window,rangeTicket); acceptMarketHistory(s.ticker,res,{...marketHistoryPage,bars:[...rawRows].sort((a,b)=>a.start-b.start)},s.mw_window,rows);}
        if(accepted && globalThis.MWNativeReserve) requestAnimationFrame(()=>MWNativeReserve.delivered(s,res,performance.now()-reserveStarted));
        if(!rows.length) finishTerminal();
        return;
      }
      const requested = Math.max(1, Math.ceil(p.countBack));
      if (!Number.isSafeInteger(requested)) throw Error('无效历史根数');
      const key=symbol+'|'+res, epoch=workspaceEpoch;
      let session=managedSessions.get(key);
      const studyKey=identity.spec ? JSON.stringify(identity.spec) : null;
      if (!session || studyKey && !session.indicators?.has(studyKey)) {
        const geometry=datasetGeometry(s.ticker,res);
        const dataset=await request({op:'dataset',args:{instrument:symbol,timeframe:frames[res],
          ...geometry, ...(identity.spec ? {indicators:[identity.spec]} : {})}},'market');
        if(epoch!==workspaceEpoch) return;
        send({type:'managed-dataset',dataset});
        if (!dataset.ready) {
          if (dataset.reason==='unmaintained' && !nativeReadonly && !maintenanceAsked.has(symbol)) {
            maintenanceAsked.add(symbol);
            send({type:'error',error:'历史尚未配置，请从图表顶部的数据中心维护。'});
          }
          if(cb([],{noData:true}) !== false) acceptMarketHistory(s.ticker,res,{bars:[]},s.mw_window);
          finishTerminal();
          return;
        }
        session ||= {start:dataset.start,revision:dataset.revision,indicators:new Set()};
        if(studyKey) session.indicators.add(studyKey);
        managedSessions.set(key,session);
      }
      let before=p.to*1000 + (['1D','1W','1M'].includes(res) ? 2*86400000 : 0);
      let rows=[], rawRows=[], boundary=false;
      while(rows.length < requested) {
        const page=await query(s.ticker,res,{before,limit:Math.min(2000,requested-rows.length)},Infinity,undefined,
          {purpose:p.firstDataRequest ? 'first-screen' : 'navigation'});
        marketHistoryPage ||= page;
        if(epoch!==workspaceEpoch || !hasHistoryViewer({instrument:symbol,timeframe:frames[res]})) {
          const error=Error('已取消旧图表的历史加载');error.code='HISTORY_CANCELLED';throw error;
        }
        rawRows.push(...page.bars);
        rows=barsOf(page,res,s.ticker).filter(bar=>bar.time<p.to*1000).concat(rows);
        boundary=!page.has_more;
        if(boundary) break;
        const next=page.bars[0]?.start;
        if(!(next<before)) throw Error('已发布历史分页未推进');
        before=next;
      }
      rows=[...new Map(rows.map(bar=>[bar.time,bar])).values()].sort((a,b)=>a.time-b.time);
      const accepted = cb(rows,{noData:boundary}) !== false;
      if(accepted && rows.length) {
        firstHistory.set(s.ticker+'|'+res,Math.min(firstHistory.get(s.ticker+'|'+res)??Infinity,rows[0].time));
        lastHistory.set(s.ticker+'|'+res,Math.max(lastHistory.get(s.ticker+'|'+res)||0,rows.at(-1).time));
      }
      if (accepted) {observeRangeBars(s.ticker,res,rawRows,rows,'',rangeTicket); acceptMarketHistory(s.ticker,res,{...marketHistoryPage,bars:[...rawRows].sort((a,b)=>a.start-b.start)},s.mw_window,rows);}
      if(!rows.length) finishTerminal();
    } catch (e) {
      err(e);
      finishTerminal();
      if (e.code !== "HISTORY_CANCELLED" && e.code !== "NATIVE_HISTORY_CAPACITY_EXCEEDED")
        send({ type: "error", error: String(e) });
    } finally {
      // Keep the notice through native callback processing and the next paint.
      // No reset or synthetic barset is introduced for UI feedback.
      if(isProvider) requestAnimationFrame(()=>requestAnimationFrame(()=>
        send({type:'native-load-end',id:loadId,epoch:loadEpoch})));
      if(providerWork) {
        providerWork.inflight--;
        if(loadEpoch===workspaceEpoch) setTimeout(()=>flushProviderCorrections(),0);
      }
      if (p.firstDataRequest && !decode(s.ticker).spec && initialHistoryGate?.epoch === loadEpoch)
        initialHistoryGate.resolve();
    }
  },
  subscribeBars: (s, res, cb, id, reset) => {
    feed.unsubscribeBars(id);
    const identity=decode(s.ticker);
    if(identity.symbol.startsWith("YAHOO:") && s.supported_resolutions && !s.supported_resolutions.includes(res)) return;
    const historyKey=s.ticker+'|'+res+(identity.series_kind==='provider' ? '|'+(s.mw_window || '') : '');
    const guardedReset = () => {barRangeMapping?.invalidate(s.ticker,res,s.mw_window); reset();};
    const sub={symbol:s.ticker,res,cb,reset:guardedReset,last:lastHistory.get(historyKey)||0,revision:null,
      initialIndicatorPending:fixedIndicatorPending.get(historyKey) || false};
    subscriptions.set(id,sub);
    // Keep history corrections subscribed, but never append a latest tick
    // across the gap between a historical window and the realtime tail.
    if (s.mw_window) {
      sub.window=s.mw_window; sub.historical=MWNativeNavigation.historical(s.mw_window);
      if (sub.historical) sub.last=MWNativeNavigation.coverage(s.mw_window)?.last || sub.last;
    }
    if(identity.series_kind==='provider') {
      if(!marketPollingFallback) {
        sub.marketListener=crypto.randomUUID(); registerMarketBar(sub); return;
      }
      sub.providerListener=crypto.randomUUID();
      const state=providerHistoryState.get(s.ticker+'|'+res)||{};
      send({type:'provider-subscribe',args:{client:clientId,listener:sub.providerListener,
        instrument:identity.symbol,timeframe:frames[res],cursor:sub.last,
        revision:state.revision||0,observed_at:state.observed_at||0,
        indicators:identity.spec?[{...identity.spec,calculation_origin:alertCalculationOrigins.get(MWSeries.encode(identity.symbol,identity.series_kind)+'|'+res) ?? null}]:[]}});
    }
    if(!marketPollingFallback) {sub.marketListener=crypto.randomUUID(); registerMarketBar(sub);}
  },
  unsubscribeBars: id => {
    const sub=subscriptions.get(id);
    endMarketRequestObservation(sub);
    if(sub)compositeDisplayBatches.cancel(indicatorKey(sub.symbol,sub.res));
    clearTimeout(sub?.marketRetry);
    if(sub?.marketListener)
      send({type:'market-unsubscribe',args:{client:clientId,listener:sub.marketListener,generation:sub.marketGeneration}});
    if(sub?.providerListener)
      send({type:'provider-unsubscribe',args:{client:clientId,listener:sub.providerListener}});
    subscriptions.delete(id);
    if (sub?.window && ![...subscriptions.values()].some(other=>other.window===sub.window)) {
      const key=sub.symbol+'|'+sub.res+'|'+(sub.window || '');
      providerHistoryWork.delete(key);lastHistory.delete(key);firstHistory.delete(key);
    }
  },
};
let polling = false;
function chartUsesSymbol(chart, symbol, res) {
  if (chart.resolution() !== res) return false;
  if (MWSeries.same(chart.symbol(), symbol)) return true;
  for (const study of chart.getAllStudies?.() || []) {
    try {
      const inputs = chart.getStudyById(study.id).getInputValues();
      if (
        inputs.some((input) => input.id === "symbol" && MWSeries.same(input.value, symbol))
      )
        return true;
    } catch {
      // A study can disappear while its outstanding request completes.
    }
  }
  return false;
}
function hasHistoryViewer(args) {
  if (!ready) return true;
  for (let i = 0; i < widget.chartsCount(); i++) {
    const chart = widget.chart(i);
    if (
      frames[chart.resolution()] === args.timeframe &&
      chartUsesSymbol(chart, args.instrument, chart.resolution())
    )
      return true;
  }
  return false;
}
function providerWindowMatches(chart, work) {
  return (globalThis.MWNativeNavigation?.chartWindow(chart)?.id || '') === (work.window || '');
}
function hasProviderWindowViewer(work) {
  return ready && Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).some(
    chart=>chartUsesSymbol(chart,work.symbol,work.res) && providerWindowMatches(chart,work));
}
let historyReloading = false;
globalThis.setInterval?.(()=>{
  resumeDeferredDisplayRecoveries();
  for(const sub of subscriptions.values())if(sub.reviewPending && !sub.resetReview &&
     Date.now()>=(sub.reviewRetryAt||0)) {
    sub.reviewRetryAt=Date.now()+30000;
    void reviewProviderReset(sub,{revision:sub.resetRevision}).catch(()=>{});
  }
},5000);

function reviewProviderReset(sub, event) {
  sub.resetRevision=Math.max(sub.resetRevision||0,event.revision||0);
  sub.reviewPending=true;
  if(sub.resetReview) return sub.resetReview;
  const epoch=workspaceEpoch;
  const current=()=>epoch===workspaceEpoch &&
    [...subscriptions.values()].includes(sub);
  const task=(async()=>{
    for(let attempt=0;attempt<3 && current();attempt++) {
      const work=providerHistoryWork.get(sub.symbol+'|'+sub.res+'|'+(sub.window || ''));
      const observation=work?.observation;
      if(!observation) throw Error('历史数据尚未完成观察，请稍后刷新历史');
      if(sub.resetRevision<=observation.revision) {sub.reviewPending=false;return;}
      // Stream gaps do not prove delivered history changed. Verify delivered
      // bars and indicator dependencies before invalidating the native source.
      const page=await query(sub.symbol,sub.res,{
        limit:1,countBack:1,before:observation.last+1,
        native_history:{...nativeHistoryContext(sub.symbol,sub.res),historical_navigation:true},
        history_observation:{...observation},
      },Date.now()+30000,current);
      if(!current()) return;
      if(!page.history_revalidation || historyOlder(page,{
        revision:observation.revision,observed_at:observation.observed_at}))
        throw Error('历史更正尚未核实，请刷新历史');
      if(page.history_revalidation.changed) {
        // A transport gap alone does not invalidate painted history. Once a
        // delivered interval is proven changed, reject its metadata/tickets
        // immediately, including when user navigation defers the native reload.
        barRangeMapping?.invalidate(sub.symbol,sub.res,sub.window);
        sub.needsHistoryReload=true;
        if(await reloadHistory(sub.symbol,sub.res,chart=>providerWindowMatches(chart,sub))) {
          sub.needsHistoryReload=false;sub.reviewPending=false;
        }
        return;
      }
      if(work.observation!==observation) continue;
      work.observation={...observation,revision:page.cache_revision||0,observed_at:page.as_of||0};
      if(sub.resetRevision<=work.observation.revision) {sub.reviewPending=false;return;}
    }
    if(current()) throw Error('历史更正尚未核实，请刷新历史');
  })();
  sub.resetReview=task;
  return task.finally(()=>{if(sub.resetReview===task)sub.resetReview=null;});
}
function mergeProviderCorrection(work,generation,verified,original) {
  // A failed/older review cannot erase an earlier confirmed real revision.
  const originals=[...(work.correction?.originals || [])];
  let overflow=work.correction?.overflow || false;
  if(original && !originals.some(item=>JSON.stringify(item)===JSON.stringify(original))) {
    if(originals.length<64) originals.push(original);
    else overflow=true;
  }
  work.correction={generation,verified:verified || work.correction?.verified === true,
    attempts:0,originals,overflow};
}
async function refreshProviderHistoryCorrections() {
  // Explicit user recovery uses the existing backend contract. Each click
  // performs one check per pending active sequence, without automatic retries.
  const epoch=workspaceEpoch;
  for(const work of providerHistoryWork.values()) {
    const correction=work.correction;
    if(!correction || work.inflight || work.reloading) continue;
    const {symbol,res}=work;
    if(!hasProviderWindowViewer(work)) continue;
    if(!correction.verified && correction.originals.length) {
      work.reloading=true;
      try {
        const deadline=Date.now()+8000;
        const proofs=[];
        for(const original of [...correction.originals]) {
          const page=await query(symbol,res,{...original.args,
            history_observation:original.observation},deadline);
          if(epoch!==workspaceEpoch || work.correction!==correction) break;
          if(!page.history_revalidation || historyOlder(page,providerHistoryState.get(symbol+'|'+res)))
            throw Error('尚未取得最新历史复核结果');
          if(page.history_revalidation.changed) {
            correction.verified=true;
            break;
          }
          proofs.push(page);
        }
        if(epoch!==workspaceEpoch || work.correction!==correction) continue;
        if(!correction.verified && proofs.length===correction.originals.length) {
          if(correction.overflow) throw Error('历史检查积压，请重新打开工作区');
          const seen=providerHistoryState.get(symbol+'|'+res);
          if(proofs.some(proof=>historyOlder(proof,seen) || proofs.some(other=>
            historyOlder(proof,{revision:other.cache_revision||0,observed_at:other.as_of||0}))))
            throw Error('历史检查期间出现新版本，请再次刷新历史');
          if(!work.inflight) work.correction=null;
          continue;
        }
      } catch(error) {send({type:'error',error:'历史检查未完成：'+String(error)});}
      finally {work.reloading=false;}
    }
    correction.attempts=0;
  }
  await flushProviderCorrections();
}
function historyOlder(page,seen) {
  return !!seen && ((page.cache_revision||0)<seen.revision ||
    (page.as_of||0)<seen.observed_at);
}
async function flushProviderCorrections() {
  if(!ready || loading || historyReloading || rangeGuard?.busy() || edgeGuard?.busy()) return;
  for(const work of providerHistoryWork.values()) {
    const correction=work.correction;
    if(work.inflight || work.reloading || !correction?.verified || correction.attempts) continue;
    const {symbol,res}=work;
    if(!hasProviderWindowViewer(work)) continue;
    work.reloading=true;
    correction.attempts++;
    const epoch=workspaceEpoch;
    try {
      const corrected=await reloadHistory(symbol,res,chart=>providerWindowMatches(chart,work));
      if(corrected && epoch===workspaceEpoch && !work.inflight && work.correction===correction)
        work.correction=null;
      else if(!corrected) send({type:'error',error:'历史更正待处理，请刷新历史'});
    } catch(error) {send({type:'error',error:'历史更正未完成：'+String(error)});}
    finally {work.reloading=false;}
  }
}
async function reloadHistory(symbol, res, relevant = () => true, detailed = false) {
  // Existing callers need a success flag; snapshot recovery also needs to know
  // whether native work actually started before spending its failure budget.
  const result=(status,reason)=>detailed ? {status,reason} : status==='restored';
  if(!ready)return result('cancelled','workspace_not_ready');
  const blocked=loading ? 'workspace_loading' : historyReloading ? 'history_reload_busy' :
    globalThis.MWNativeNavigation?.busy() ? 'navigation_busy' : rangeGuard?.busy() ? 'range_busy' : edgeGuard?.busy() ? 'edge_busy' : null;
  if(blocked)return result('deferred',blocked);
  if (Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).some(chart=>
      chartUsesSymbol(chart,symbol,res) && relevant(chart) && globalThis.MWNativeNavigation?.interacting(chart))) return result('deferred','user_interacting');
  if(!Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).some(chart=>chartUsesSymbol(chart,symbol,res) && relevant(chart)))return result('cancelled','viewer_removed');
  historyReloading = true;
  edgeGuard?.retry();
  const epoch = workspaceEpoch;
  const invalidated = new Set();
  try {
    for (let i=0;i<widget.chartsCount();i++) {
      const chart=widget.chart(i);
      if (!chartUsesSymbol(chart,symbol,res) || !relevant(chart)) continue;
      const window=globalThis.MWNativeNavigation?.chartWindow(chart)?.id || '';
      // A rebuild creates a new accepted-data generation. Clear the old
      // interval index before any asynchronous native refresh can complete.
      barRangeMapping?.invalidate(symbol,res,window);
      if (window) {
        // Native resetCache and resetData both mutate the same source. Rebuild
        // an isolated historical source once, with a fresh validated seed.
        const restored=await MWNativeNavigation.refreshChartWindow(chart);
        if(epoch!==workspaceEpoch || !relevant(chart) || !chartUsesSymbol(chart,symbol,res))return result('cancelled','stale_native_generation');
        if (!restored) return result('failed','window_refresh_failed');
        continue;
      }
      const rangeKey=symbol+'|'+res+'|'+window;
      if (chart.getTimeScale().rightOffset()<0)
        refreshingHistoryRanges.set(rangeKey,chart.getVisibleRange());
      let restored;
      try { restored=await refreshChartHistory(widget,chart,()=>{
        if (invalidated.has(window)) return;
        invalidated.add(window);
        let notified=false;
        for (const sub of subscriptions.values()) {
          if (MWSeries.same(sub.symbol,symbol) && sub.res===res && (sub.window || '')===window) {
            sub.reset();notified=true;
          }
        }
        if (!notified && !window) widget.resetCache();
      },()=>epoch===workspaceEpoch && chartUsesSymbol(chart,symbol,res));
      } finally { refreshingHistoryRanges.delete(rangeKey); }
      if(epoch!==workspaceEpoch || !relevant(chart) || !chartUsesSymbol(chart,symbol,res))return result('cancelled','stale_native_generation');
      if (!restored) return result('failed','native_reset_failed');
    }
    return result('restored','native_reset_complete');
  } finally { historyReloading=false;Promise.resolve().then(resumeDeferredDisplayRecoveries); }
}
async function refreshManagedHistory(instrument) {
  if(!ready || loading) return;
  if(historyReloading || rangeGuard?.busy() || edgeGuard?.busy()) {
    send({type:'error',error:'图表当前正在操作，请稍后再次刷新历史'});
    return;
  }
  const charts=Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i));
  const refreshed=new Set();
  for(const chart of charts) {
    const identity=decode(chart.symbol()), res=chart.resolution();
    if(identity.series_kind!=='managed' || instrument && identity.symbol!==instrument) continue;
    const key=identity.symbol+'|'+res;
    if(refreshed.has(key)) continue;
    refreshed.add(key);
    managedSessions.delete(key);
    cache.clear();
    if(!await reloadHistory(identity.symbol,res))
      send({type:'error',error:'图表当前正在操作，请稍后再次刷新历史'});
  }
}
async function tick() {
  if(!marketPollingFallback) return;
  if (polling) return;
  polling = true;
  const epoch = workspaceEpoch;
  const quoteBindings = [...quoteSubscriptions].map(([id, sub]) => ({id, sub,
    initialRows: new Map(sub.symbols.map(ticker => [ticker, quoteSnapshotRows.get(ticker)]))}));
  const current = ({id, sub}) => epoch === workspaceEpoch && quoteSubscriptions.get(id) === sub;
  const initialQuotes = new Map(quoteBindings.flatMap(({initialRows}) => [...initialRows]));
  const resetTokens = new Map([...initialQuotes.keys()].map(ticker => [ticker, quoteResetTokens.get(ticker)]));
  const currentSymbols = () => [...new Set(quoteBindings.filter(current).flatMap(({sub}) => sub.symbols))]
    .filter(ticker => quoteResetTokens.get(ticker) === resetTokens.get(ticker));
  try {
    const quoteSymbols = [
      ...new Set(quoteBindings.flatMap(({sub}) => sub.symbols)),
    ];
    if (quoteSymbols.length) {
      try {
        const rows = [];
        for (let i = 0; i < quoteSymbols.length; i += 100)
          rows.push(
            ...(await request(
              {
                op: "quotes",
                args: {
                  symbols: quoteSymbols.slice(i, i + 100),
                  client: clientId,
                },
              },
              "market",
            )),
          );
        const active = new Set(currentSymbols());
        rememberQuoteRows(rows.filter(r => active.has(r.n) &&
          quoteSnapshotRows.get(r.n) === initialQuotes.get(r.n)));
        for (const binding of quoteBindings) {
          if (!current(binding)) continue;
          const {sub} = binding;
          const symbols = sub.symbols.filter(ticker => active.has(ticker));
          for(const row of rows.filter(row=>symbols.includes(row.n))) {
            const state=quoteReadState(row);
            if(state !== 'waiting') marketRequestNotice(sub,row.n,'quotes',state==='failed' ? Error('报价抓取失败') : null);
          }
          if (symbols.length) sub.cb(symbols.map(ticker => quoteSnapshotRows.get(ticker)).filter(Boolean).map(presentQuote));
        }
        send({ type: "feed-poll-state", key: "@quotes", error: "" });
      } catch (e) {
        const rows = quoteFailureRows(currentSymbols(), initialQuotes);
        for (const binding of quoteBindings) {
          if (!current(binding)) continue;
          for(const ticker of binding.sub.symbols.filter(ticker=>currentSymbols().includes(ticker)))marketRequestNotice(binding.sub,ticker,'quotes',e);
          const selected = rows.filter(row => binding.sub.symbols.includes(row.n));
          if (selected.length) binding.sub.cb(selected);
        }
        send({ type: "feed-poll-state", key: "@quotes", error: "报价更新失败：" + String(e) });
      }
    } else {
      send({ type: "feed-poll-state", key: "@quotes", error: "" });
    }
    for (const [key, args] of [...pendingHistory]) {
      if (!hasHistoryViewer(args)) {
        pendingHistory.delete(key);
        continue;
      }
      let state;
      try {
        state = await historyQuery(args);
      } catch (e) {
        send({ type: "error", error: String(e) });
        continue;
      }
      if (pendingHistory.get(key) !== args) continue;
      if (!hasHistoryViewer(args)) {
        pendingHistory.delete(key);
        continue;
      }
      if (state.status === "error") {
        pendingHistory.delete(key);
        rememberHistoryFailure(args, state);
        send({ type: "error", error: state.error || "历史拉取失败" });
        continue;
      }
      if (state.status === "ready" || state.status === "empty_interval") {
        const res = Object.keys(frames).find(
          (value) => frames[value] === args.timeframe,
        );
        if (!res || await reloadHistory(args.instrument, res)) pendingHistory.delete(key);
      }
    }
    const groups = new Map();
    for (const sub of subscriptions.values()) {
      let key = sub.symbol + sub.res;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sub);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const identity = decode(first.symbol);
      if (identity.series_kind === 'provider') continue;
      const symbol = MWSeries.encode(identity.symbol, identity.series_kind);
      if (!hasHistoryViewer({ instrument: symbol, timeframe: frames[first.res] })) {
        for (const sub of group) sub.pausedForLayout = true;
        continue;
      }
      if (group.some((sub) => sub.pausedForLayout)) {
        // Refill bars missed while the native pane retained a hidden subscription.
        if (await reloadHistory(symbol, first.res))
          for (const sub of group) sub.pausedForLayout = false;
        // A busy viewport may defer its historical reset; visible realtime
        // polling must still resume instead of waiting for that reset to finish.
      }
      try {
        if (identity.series_kind === 'managed' && !managedSessions.has(identity.symbol+'|'+first.res)) continue;
        const rangeTicket = barRangeMapping?.capture(first.symbol,first.res,first.window);
        const result = await query(first.symbol, first.res, {
          limit: 3,
          track_history: true,
          revision_after: (['history','composite'].includes(identity.series_kind) ? fixedHistoryStarts : firstHistory)
            .get(first.symbol + "|" + first.res),
          ...(first.historyBefore
            ? { revision_before: first.historyBefore }
            : {}),
        });
        const dependencyOrigin=indicatorDependencyOrigins.get(indicatorKey(first.symbol,first.res));
        const acceptedBinding=indicatorBindings.get(indicatorKey(first.symbol,first.res));
        if(!identity.spec && dependencyOrigin!=null && acceptedBinding?.firstStart>dependencyOrigin){
          const dependencyPage=await query(first.symbol,first.res,{limit:1,track_history:true,
            revision_before:acceptedBinding.firstStart,revision_after:null,
            ...(identity.series_kind==='managed' ? {dataset_start:dependencyOrigin} : {revision_after:dependencyOrigin})});
          const revision=dependencyPage.history_check?.revision;
          const corrected=revision && acceptedBinding.dependencyRevision && revision!==acceptedBinding.dependencyRevision;
          acceptedBinding.dependencyBefore=acceptedBinding.firstStart;
          acceptedBinding.dependencyRevision=revision;
          if(corrected)rememberIndicatorBinding(first.symbol,first.res,{}, {correction:true});
        }
        rememberIndicatorBinding(first.symbol,first.res,result);
        const bars = barsOf(result, first.res, first.symbol);
        const check = result.history_check;
        const progressBoundary = first.historyBefore || check?.before;
        const indicatorProgress = JSON.stringify((result.indicator_progress || []).map(item =>
          [Math.min(item.cursor,progressBoundary ?? item.cursor),
            item.cursor < (progressBoundary ?? item.cursor) ? 'pending' : 'ready']));
        let needsReload = group.some(sub=>sub.needsHistoryReload);
        for (const sub of group) {
          if (identity.spec && sub.initialIndicatorPending && result.indicator_progress?.every(item=>item.status==='complete')) {
            sub.initialIndicatorPending = false;
            sub.needsHistoryReload = true;
            needsReload = true;
          }
          if (identity.spec && sub.indicatorProgress && sub.indicatorProgress !== indicatorProgress) {
            sub.needsHistoryReload = true;
            needsReload = true;
          }
          sub.indicatorProgress = indicatorProgress;
          const changed =
            check &&
            sub.historyBefore === check.before &&
            sub.historyAfter === check.after &&
            sub.historyRevision &&
            sub.historyRevision !== check.revision;
          if (check) {
            sub.historyBefore = check.next_before;
            sub.historyAfter = check.after;
            sub.historyRevision = check.next_revision;
          }
          if (changed) {
            needsReload = true;
            sub.needsHistoryReload = true;
            continue;
          }
          if (!sub.last && bars.length) sub.last = bars.at(-1).time;
          sub.last=Math.max(sub.last||0,lastHistory.get(first.symbol+'|'+first.res)||0);
          for (const bar of bars)
            if (bar.time >= sub.last) {
              sub.cb({ ...bar });
              observeRangeBars(sub.symbol,sub.res,result.bars,[bar],sub.window,rangeTicket);
              sub.last = bar.time;
            }
        }
        if (needsReload && await reloadHistory(symbol, first.res))
          for (const sub of group) sub.needsHistoryReload = false;
        if(epoch===workspaceEpoch)for(const sub of group)if([...subscriptions.values()].includes(sub))marketRequestNotice(sub,sub.symbol,sub.res,null);
        send({ type: "feed-poll-state", key: first.symbol + "|" + first.res, error: "" });
        if (result.pending?.length) send({type:'status',text:result.pending.join('；')});
      } catch (e) {
        if(epoch===workspaceEpoch)for(const sub of group)if([...subscriptions.values()].includes(sub))marketRequestNotice(sub,sub.symbol,sub.res,e);
        send({ type: "feed-poll-state", key: first.symbol + "|" + first.res, error: String(e) });
      }
    }
  } finally {
    polling = false;
    offerHistoryRetry();
  }
}
function snapshot(manual = true) {
  if (!ready || loading) return;
  if (globalThis.MWNativeNavigation?.busy() || rangeGuard?.busy() || edgeGuard?.busy()) {
    dirty = true;
    if (manual) manualSavePending = true;
    return;
  }
  if (nativeMode) {
    if (nativeReadonly) return;
    if (nativeSaving) {
      if (manual) manualSavePending = true;
      return;
    }
    manualSavePending = false;
    send({ type: "native-saving" });
    nativeSaving = true;
    dirty = false;
    const epoch = workspaceEpoch;
    const failed = (e) => {
      nativeSaving = false;
      if (epoch === workspaceEpoch) dirty = true;
      send({ type: "error", error: String(e?.message || "工作区保存失败") });
    };
    try {
      widget.saveChartToServer(
        () => {
          nativeSaving = false;
          if (manualSavePending) snapshot();
          else if (dirty) send({type: "workspace-dirty"});
          else if (epoch === workspaceEpoch) send({ type: "native-saved" });
        },
        failed,
        { defaultChartName: savedDoc.nativeName || "我的图表" },
      );
    } catch (e) {
      failed(e);
    }
    return;
  }
  widget.save((state) =>
    send({
      type: "snapshot",
      document: {
        engine: "tv31",
        schemaVersion: 1,
        state: {...state, _mwBarRangeMapping:barRangeMapping.snapshot(),
          _mwDrawingProjection: captureDrawingProjection(widget)},
        theme: chartThemeName(widget.getTheme()) || "Dark",
        templates: savedDoc.templates || {},
      },
    }),
  );
}
function boot(
  doc,
  readonly = false,
  catalog = {},
  preferences = [],
  workspace = null,
  symbolMetadata = null,
  initialWatchlistMetadata = {},
) {
  initialSymbol = symbolMetadata;
  watchlistMetadata.clear();
  for (const [ticker, metadata] of Object.entries(initialWatchlistMetadata || {}))
    if (typeof ticker === "string" && metadata && typeof metadata === "object")
      watchlistMetadata.set(ticker.toLowerCase(), metadata);
  if(symbolMetadata?.metadata) {
    const ticker = symbolMetadata.ticker;
    const symbol = decode(ticker).symbol;
    symbolPresentations.set(ticker,symbolMetadata.metadata);
    if (!symbolPresentations.has(symbol)) symbolPresentations.set(symbol,symbolMetadata.metadata);
  }
  // save_load_adapter content is a layout envelope; saved_data expects its chart state.
  const storedViewports = doc.state?._mwViewports;
  let chartState = doc.state;
  if (
    chartState &&
    !chartState.charts &&
    typeof chartState.content === "string"
  ) {
    try {
      chartState = JSON.parse(chartState.content);
    } catch (e) {
      send({ type: "error", error: "工作区内容无法解析：" + String(e) });
      return;
    }
  }
  let grid;
  let selectedTheme = chartInitialTheme(preferences, doc, chartState);
  let pendingThemeState = chartState || {}, themeRestoring = false;
  const restoreTheme = async () => {
    if (pendingThemeState === undefined) return;
    const state = pendingThemeState;
    pendingThemeState = undefined;
    themeRestoring = true;
    try { await restoreChartTheme(widget, state, selectedTheme); }
    finally { themeRestoring = false; }
  };
  const pendingGridStyle = chartState?._mwGridStyle;
  let pendingBarRange = doc.state?._mwBarRangeMapping || chartState?._mwBarRangeMapping;
  let pendingViewports = storedViewports || chartState?._mwViewports;
  let pendingSync = doc.state?._mwSync || chartSynchronizationState(chartState);
  const ensureSync = () => {
    if (!widget._mwSyncCoordinator) {
      syncCoordinator?.dispose();
      syncCoordinator = chartSyncCoordinator(widget,{initial:pendingSync,readonly,changed:()=>{
        markWorkspaceDirty();
        widget._innerAPI()._saveChartService?.markContentAsChanged();
      }});
      globalThis.MWSyncCoordinator = syncCoordinator;
    }
    return widget._mwSyncCoordinator;
  };
  const prepareLegacyViewports = (state, modernSync = state?._mwSync) => {
    beforeInitialHistory = state && !modernSync ? () => {
      beforeInitialHistory = undefined;
      // Cached native layouts may finish loading before a delayed getBars.
      // Such a callback cannot acquire a pause that chart_loaded already ended.
      if (!loading) return;
      ensureSync();
      pendingSync = deferLegacyChartSynchronization(widget);
    } : undefined;
  };
  prepareLegacyViewports(chartState, doc.state?._mwSync || chartState?._mwSync);
  if (chartState) {
    chartState = { ...chartState };
    delete chartState._mwViewports;
    delete chartState._mwSync;
    delete chartState._mwGridStyle;
    delete chartState._mwBarRangeMapping;
    delete chartState._mwDrawingProjection;
    delete chartState._mwTheme;
  }
  let viewportRestoring = false, workspaceLoadPause;
  const restoreViewports = async () => {
    const viewports = pendingViewports;
    pendingViewports = undefined;
    if (!viewports) return;
    const epoch = workspaceEpoch;
    viewportRestoring = true;
    try {
      await restoreChartViewports(
        widget,
        viewports,
        () => epoch === workspaceEpoch,
      );
    } catch (e) {
      send({ type: "error", error: "视区恢复失败：" + String(e) });
    } finally {
      if (epoch === workspaceEpoch) viewportRestoring = false;
    }
  };
  // Rebuild via public APIs: merely hiding extra panes leaves the vendor's
  // period-switch series metadata unresolved. This snapshot never leaves memory.
  const rebuildMobileSingleChart = async () => {
    if (!readonly || widget.chartsCount() <= 1) return false;
    const epoch = workspaceEpoch;
    widget.setLayout("s");
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (epoch !== workspaceEpoch) return true;
    const single = await new Promise((resolve) => widget.save(resolve));
    if (epoch !== workspaceEpoch) return true;
    const current = currentNativeWorkspace;
    await widget.load(
      single,
      current
        ? {
            uid: current.id,
            name: current.name,
            description: current.name,
          }
        : undefined,
    );
    return true;
  };
  savedDoc = doc;
  savedDoc.nativeName = workspace?.name || "我的图表";
  nativeMode = true;
  nativeReadonly = readonly;
  let currentNativeWorkspace = workspace;
  let attachingAlerts = 0, alertAttachQueue = Promise.resolve(), alertUIStopped = false;
  invalidateAlertUI = () => {
    attachingAlerts++;
    publishNotificationTimezone("UTC", "UTC（图表初始化前）");
    noticeUI?.destroy(); noticeUI = undefined;
    alertUI?.destroy(); alertUI = undefined;
  };
  // Serialize private widgetbar mutations. A cancelled attach must finish and
  // restore its shell before a newer session can install another one.
  alertUIAttach = () => {
    if (alertUIStopped || loading || !ready || String(currentNativeWorkspace?.id) !== alertUIWorkspace) return Promise.resolve();
    const attempt = ++attachingAlerts, session = alertUISession, workspaceId = alertUIWorkspace;
    alertAttachQueue = alertAttachQueue.then(async () => {
    if (attempt !== attachingAlerts || alertUIStopped) return;
    noticeUI?.destroy(); noticeUI = undefined;
    alertUI?.destroy(); alertUI = undefined;
    try {
      refreshNotificationTimezone();
      const instance = await MWNativeAlerts.attach({widget, scope: {workspace_id: workspaceId, session}, readonly,
        initialDraft: alertUIDraft, noticeState,
        noticeRequest: query => request({workspace_id:workspaceId,session,...query}, 'notice-center-rpc', () => attempt === attachingAlerts && session === alertUISession),
        persistDraft: draft => send({type:'chart-alert-ui-draft', workspace_id: workspaceId, session, draft}),
        panelChanged: (open,signal_id) => {restoreAlertsPanel = open; send({type:'alerts-panel-state',workspace_id:workspaceId,open,signal_id});},
        bridge: alertBridge, request: query => request(query, 'chart-alert-ui-rpc', () => attempt === attachingAlerts && session === alertUISession),
        report: error => send({type:'error', error:String(error)})});
      if (attempt !== attachingAlerts || session !== alertUISession || alertUIStopped) {instance.destroy();return;}
      alertUI = instance; instance.theme(widget.getTheme()); if(noticeState)instance.noticeState(noticeState);
      if (restoreAlertsPanel) instance.open();
      if (alertOpenSignal) {instance.event(alertOpenSignal);alertOpenSignal=undefined;}
      try {
        const scope={workspace_id:workspaceId,session,epoch:workspaceEpoch};
        const notification=await MWNativeNotifications.attach({widget,scope,state:noticeState,
          request:query=>request({...scope,...query},'notice-center-rpc',()=>attempt===attachingAlerts && session===alertUISession),
          panelChanged:(open,event)=>send({type:'notice-center-panel',...scope,open,event}),
          alert:signal=>{alertUI?.event(signal);send({type:'alerts-panel-state',workspace_id:workspaceId,open:true});},
          locate:row=>send({type:'notice-center-locate',...scope,event_id:row.id}),
          report:error=>send({type:'error',error:String(error)})});
        if(attempt!==attachingAlerts || session!==alertUISession || alertUIStopped){notification.destroy();return;}
        noticeUI=notification;send({type:'notice-center-ready',...scope});
        if(noticeOpenEvent!==undefined){notification.open(noticeOpenEvent || undefined);noticeOpenEvent=undefined;}
      } catch(error) {send({type:'notice-center-unavailable',workspace_id:workspaceId,session,error:String(error)});}

    } catch (error) {if (attempt === attachingAlerts && !alertUIStopped) send({type:'error', error:'原生告警接入失败：' + String(error)});}
    });
    return alertAttachQueue;
  };
  addEventListener('pagehide', () => {alertUIStopped = true; invalidateAlertUI();}, {once:true});
  alertBridge?.destroy();
  alertBridge = chartAlertBridge({getWidget:()=>widget,getWorkspace:()=>currentNativeWorkspace,
    getEpoch:()=>workspaceEpoch,isLoading:()=>loading||!ready,readonly,
    metadata:ticker=>alertSourceMetadata.get(MWSeries.encode(MWSeries.decode(ticker).symbol,MWSeries.decode(ticker).series_kind)),frames,
    unavailable:chart=>{
      const target=chartResolves.get(resolveChartKey(chart));
      return target && resolveCurrent(target) && target.state!=='ready' ? target.message : null;
    },
    calculationOrigin:(ticker,res)=>alertCalculationOrigins.get(MWSeries.encode(MWSeries.decode(ticker).symbol,MWSeries.decode(ticker).series_kind)+'|'+res) ??
      indicatorBindings.get(indicatorKey(ticker,res))?.calculationStart ??
      (MWSeries.decode(ticker).series_kind === "managed" ? managedSessions.get(MWSeries.decode(ticker).symbol+'|'+res)?.start : null),
    compositeRevision:(ticker,res)=>alertCompositeRevisions.get(MWSeries.encode(MWSeries.decode(ticker).symbol,'composite')+'|'+res) ?? null,
    rpc:query=>request(query,"chart-alert-rpc"),send: message => {
      if (message.type === 'chart-alert-association') alertUI?.association(message.alert_id, message.text);
      else send(message);
    },
    fail:error=>send({type:"error",error:String(error)})});
  alertBridge.reset(chartState || {});
  const layouts = nativeWorkspaces(
    workspace,
    (op, args) => request({ op, args }, "workspace"),
    readonly,
    (row) => {
      currentNativeWorkspace = row;
      savedDoc = { ...row.document, nativeName: row.name };
    },
    (row) => {
      currentNativeWorkspace = row;
      savedDoc = { ...row.document, nativeName: row.name };
      if (!alertUI) void alertUIAttach();
    },
  );
  // Preserve native/user bar spacing across interval changes. History load
  // policy belongs to the planner (D1 foreground, W1 background, MN local),
  // not to viewport resizing or cache resets on a period switch.
  const loadContent = layouts.getChartContent;
  const saveLayout = layouts.saveChart;
  let initialNativeSave = false;
  let initialNativeSaveError;
  let busySaveNoticeShown = false;
  captureWorkspaceState = async () => {
    const state = await captureChartLayout(widget);
    alertBridge.persist(state);
    state._mwGridStyle = grid.value;
    state._mwTheme = chartThemeName(widget.getTheme());
    state._mwBarRangeMapping = barRangeMapping.snapshot();
    state._mwDrawingProjection = captureDrawingProjection(widget);
    return state;
  };
  discardWorkspaceChanges = () => {dirty = false; layouts.discardChanges();};
  layouts.saveChart = async (data) => {
    try {
      if (viewportRestoring || globalThis.MWNativeNavigation?.busy() || rangeGuard?.busy() || edgeGuard?.busy()) {
        dirty = true;
        if (!busySaveNoticeShown) {
          busySaveNoticeShown = true;
          emitNotice({source_kind:'workspace',attempt_id:crypto.randomUUID(),code:'WORKSPACE_SAVE_WAITING',severity:'info',title:'等待图表就绪',message:'图表正在切换，数据就绪后自动保存'});
        }
        // Native save callbacks serialize rejection values; Error becomes {}.
        return Promise.reject("图表正在切换，数据就绪后自动保存");
      }
      busySaveNoticeShown = false;
      // An explicit initial native save binds its returned server ID without
      // reloading the chart. Only this boot call may target the existing empty
      // workspace when the native library has no ID; later Save As stays a copy.
      if (initialNativeSave && data.id == null) data = {...data, id: workspace.id};
      const revision = editRevision, epoch = workspaceEpoch;
      const state = await captureWorkspaceState();
      if (epoch !== workspaceEpoch || editRevision !== revision) {
        dirty = true;
        throw new Error("图表在保存期间已修改，请重试保存");
      }
      // Native save metadata uses the resolved display name, which omits MWP:
      // and can belong to a different active pane. Pin it to the captured first
      // chart's public identity so list/load metadata retains the series kind.
      const primary = state._mwViewports[0];
      const result = await saveLayout({ ...data, symbol: primary.symbol,
        resolution: primary.resolution, content: JSON.stringify(state) });
      if (epoch === workspaceEpoch && editRevision === revision) {
        dirty = false;
        send({type: "native-saved"});
      }
      return result;
    } catch (error) {
      // Native callbacks serialize Error and lose its non-enumerable message.
      if (initialNativeSave) initialNativeSaveError = String(error);
      throw error;
    }
  };
  const viewportBindings = new Map();
  const symbolResolutionBindings = new Map();
  const bindViewports = () => {
    // Symbol change events also fire for the library's cached resolutions.
    // resolveSymbol alone cannot correct a return to a previously seen symbol.
    for(const [chart,changed] of symbolResolutionBindings)
      {chart.onSymbolChanged().unsubscribe(null,changed);chart.onIntervalChanged().unsubscribe(null,changed);}
    symbolResolutionBindings.clear();
    for(let index=0; index<widget.chartsCount(); index++) {
      const chart=widget.chart(index);
      const changed=info=>{
        if(info.ticker && decode(info.ticker).symbol.startsWith("YAHOO:") &&
           info.supported_resolutions && !info.supported_resolutions.includes(chart.resolution()))
          chart.setResolution("60",{doNotActivateChart:true});
        reportResolveStates();
        synchronizeMarketVisibility();
      };
      chart.onSymbolChanged().subscribe(null,changed);
      chart.onIntervalChanged().subscribe(null,changed);
      symbolResolutionBindings.set(chart,changed);
    }
    for (const [chart, changed] of viewportBindings)
      chart.onVisibleRangeChanged().unsubscribe(null, changed);
    viewportBindings.clear();
    if (readonly) return;
    for (let i = 0; i < widget.chartsCount(); i++) {
      const chart = widget.chart(i);
      const changed = () => {
        if (viewportRestoring) return;
        markWorkspaceDirty();
      };
      viewportBindings.set(chart, changed);
      chart.onVisibleRangeChanged().subscribe(null, changed);
    }
  };
  layouts.getChartContent = async (id) => {
    try {
      if (dirty) {
        // Loading another layout must not silently discard edits when the
        // user explicitly disabled automatic saving.
        if (!await request({}, "confirm-leave")) throw Error("已取消切换工作区");
        dirty = false; layouts.discardChanges();
      }
      const state = JSON.parse(await loadContent(id));
      pendingThemeState = state;
      alertBridge.reset(state);
      grid.restore(state._mwGridStyle);
      pendingBarRange = state._mwBarRangeMapping;
      delete state._mwBarRangeMapping;
      delete state._mwGridStyle;
      delete state._mwDrawingProjection;
      pendingViewports = state._mwViewports;
      pendingSync = chartSynchronizationState(state);
      prepareLegacyViewports(state);
      delete state._mwViewports;
      delete state._mwSync;
      // Keep the marker out of the native document but available for restore.
      pendingThemeState = { _mwTheme: state._mwTheme };
      delete state._mwTheme;
      return JSON.stringify(nativeLayoutContent(state, currentNativeWorkspace));
    } catch (e) {
      loading = false;
      send({ type: "error", error: String(e) });
      throw e;
    }
  };
  activePreferences?.dispose();
  const prefs = activePreferences = nativePreferences(
    preferences,
    (op, args) => request({ op, args }, "preferences"),
    readonly,
    reportPreferenceOutcome,
    (context, scope) => reportPreferenceOutcome(null, context, scope),
    capturePreferenceScope,
    {blocked:globalThis.MWPreferenceDraftKeys || [], put: draft => request({op:'draftWrite',args:draft},'preferences'),
     current: draft => request({op:'draftCheck',args:draft},'preferences'),
     abandoned: context => emitNotice({source_kind:'preferences',attempt_id:crypto.randomUUID(),code:'PREFERENCE_SAVE_FAILED',
       title:'设置草稿已放弃',message:'已明确采用服务器设置；原写入未成功',observation_ended:true,
       context:{source_id:JSON.stringify([context.kind,context.name,context.tool || '',context.operation]),consumer:'preferences-adapter',endpoint:'/advanced-charts/preferences'}},true),
     drop: draft => request({op:'draftDrop',args:draft},'preferences')},
  );
  autoSave?.dispose();
  autoSave = chartAutoSave(preferences,
    value => prefs.savePreference("setting", "mw.autoSave", value),
    () => { if (dirty) snapshot(false); }, readonly);
  savedDoc = doc;
  savedDoc.templates ||= {};
  initialHistoryGate?.resolve();
  initialHistoryGate = {epoch: workspaceEpoch};
  initialHistoryGate.promise = new Promise(resolve => {initialHistoryGate.resolve = resolve;});
  loading = true;
  ready = false;
  indicatorCoordinator?.dispose();indicatorCoordinator=undefined;indicatorBindings.clear();
  progressivePages?.dispose();
  progressivePages = undefined;
  managedSessions.clear();
  maintenanceAsked.clear();
  dataCenter?.dispose();
  swingDisplay?.dispose();
  squeezeDisplay?.dispose();
  studyTemplates?.dispose();
  indicatorPicker?.dispose();
  barRangeMapping?.dispose();
  barRangeMapping = chartBarRangeMapping({widget:()=>widget,initial:pendingBarRange,readonly,changed:()=>{
    markWorkspaceDirty();
    // Keep the native Save menu enabled for host-only configuration edits.
    widget?._innerAPI()._saveChartService?.markContentAsChanged();
  }});
  globalThis.MWBarRangeMapping = barRangeMapping;
  globalThis.MWChartMaximize?.dispose();
  globalThis.MWChartMaximize = undefined;
  unbindActiveChartEvent();
  MWNativeIndicatorResults.configure(catalog,{enable:globalThis.MW_NATIVE_RESERVE_ENABLED!==false});
  widget = new TradingView.widget({
    context_menu:{items_processor:(items,factory,params)=>alertBridge.menu(items,factory,params)},
    save_load_adapter: { ...prefs.templates, ...layouts },
    settings_adapter: prefs.settings,
    custom_indicators_getter: (PineJS) =>
      Promise.resolve(pythonStudies(PineJS, catalog)),
    container: "chart",
    library_path: globalThis.MW_CHART_LIBRARY_PATH || "/charting_library/",
    custom_css_url: "/chart-menu.css",
    datafeed: feed,
    widgetbar: {
      watchlist: true,
      details: true,
      datawindow: true,
      watchlist_settings: {
        // Restore the active list before native resolves constructor defaults.
        // Waiting until onChartReady briefly requests unrelated default symbols.
        default_symbols: (() => {
          const stored = preferences.find(p => p.kind === "setting" && p.name === "mw.watchlists.v1")?.content.value;
          const lists = Array.isArray(stored?.lists) ? stored.lists : [];
          const list = lists.find(list => list.id === stored.active) || lists[0];
          return Array.isArray(list?.symbols) ? list.symbols :
            ["EURUSD", "XAUUSD", "BTCUSDT"].map(symbol => MWSeries.encode(symbol, "provider"));
        })(),
        readonly,
      },
    },
    compare_symbols: [
      { symbol: "MWP:EURUSD", title: "EURUSD · 平台行情" },
      { symbol: "MWP:XAUUSD", title: "XAUUSD · 平台行情" },
      { symbol: "MWP:BTCUSDT", title: "BTCUSDT · 平台行情" },
    ],
    // A constructor symbol overrides the first MainSeries in saved_data.
    // Existing layouts may have stale/display-only top-level metadata; the
    // saved chart state is authoritative when restoring a layout.
    ...(!chartState?.charts?.length ? {symbol: doc.symbol || "XAUUSD"} : {}),
    interval: doc.interval || "240",
    ...(!chartState && decode(doc.symbol || "XAUUSD").series_kind === "managed" && ["1D", "1W", "1M"].includes(doc.interval)
      ? { timeframe: "3M" }
      : {}),
    locale: "zh",
    custom_formatters: { priceFormatterFactory: chartPriceFormatter },
    custom_translate_function: (original, singular, translated) => {
      if ([original, singular, translated].some(text => /^object tree$/i.test(String(text)))) return "对象树";
      if (['No data here', 'No data', 'Loading', 'Loading...'].includes(original)) return '';
      return null;
    },
    autosize: true,
    theme: selectedTheme,
    saved_data: chartState,
    saved_data_meta_info: workspace
      ? { uid: workspace.id, name: workspace.name, description: workspace.name }
      : undefined,
    auto_save_delay: 2,
    enabled_features: [
      "support_multicharts",
      "determine_first_data_request_size_using_visible_range",
      "header_layouttoggle",
      "header_in_fullscreen_mode",
      "disable_resolution_rebuild",
      "prefer_quote_short_name",
      "use_symbol_name_for_header_toolbar",
      "study_templates",
      "items_favoriting",
      "chart_template_storage",
    ],
    disabled_features: [
      "widget_logo",
      "use_localstorage_for_settings",
      "open_account_manager",
      "create_volume_indicator_by_default",
      ...(readonly
        ? [
            "left_toolbar",
            "trading_account_manager",
            "order_panel",
            "broker_button",
            "context_menus",
            "header_settings",
          ]
        : []),
    ],
  });
  widget
    .headerReady()
    .then(async () => {
      watchlistLayout?.dispose();
      watchlistLayout = globalThis.MWWatchlistLayout?.attach(widget, error =>
        send({type: "diagnostic", source: "watchlist-layout", error: String(error)}), ticker => {
          const meta=presentationFor(ticker);
          return meta?.display_symbol || meta?.symbol;
        }, ticker => symbolFlags?.colorFor?.(ticker));
      if (!readonly) indicatorPicker = chartIndicatorPicker(widget, catalog, (e) =>
        send({type: "error", error: String(e)}), () => dataCenter?.nativeUi);
      // Public left-aligned buttons retain their creation order in the header.
      if (!readonly) dataCenter = chartDataCenter({occurrence:emitNotice,widget, appOrigin: parentOrigin,
        workspace: () => currentNativeWorkspace, epoch: () => workspaceEpoch, send, searchSymbols: searchNativeSymbols,
        timezone: () => {const chart=widget.activeChart(),zone=chart.getTimezoneApi().getTimezone().id;
          return zone === "exchange" ? presentationFor(chart.symbol())?.timezone || "UTC" : zone;},
        suspendIndicators: () => indicatorPicker?.close(),
        managementRequest: (args, signal) => request(args, "data-center-api", () => !signal.aborted),
        resolve: args => request({op:"resolve",args},"market")});
    })
    .catch((e) => send({ type: "error", error: String(e) }));
  widget.onChartReady(async () => {
    await restoreTheme();
    activeTab?.dispose();
    activeTab = chartTab({widget,feed,send,workspace:()=>currentNativeWorkspace,epoch:()=>workspaceEpoch,metadata:presentationFor});
    startIndicatorCoordinator(catalog);
    globalThis.MWChartMaximize = chartBlankDoubleClick(widget, { readonly });
    ensureSync();
    syncCoordinator.refreshCharts();
    barRangeMapping.refreshCharts();
    widget.crosshairSync().subscribe(value => MWNativeNavigation.crosshairEnabled(value));
    grid = chartGridPresentation(widget, preferences,
      async value => {
        await prefs.savePreference("setting", "mw.gridStyle", value);
        markWorkspaceDirty();
      }, readonly, pendingGridStyle);
    if (!doc.state) {
      widget.crosshairSync().setValue(true);
      syncCoordinator.configure({time:true,date:true,barWidth:false},true);
      widget.intervalSync().setValue(false);
      widget.symbolSync().setValue(false);
      if (workspace && !readonly) {
        try {
          await Promise.race([new Promise(resolve=>widget.activeChart().dataReady(resolve)),
            new Promise((_,reject)=>setTimeout(()=>reject(Error('首次图格历史未能就绪；请在通知中心查看并重试')),15000))]);
          // Leave the initial ready dispatch before binding the server identity.
          await new Promise((resolve) => setTimeout(resolve, 0));
          initialNativeSave = true;
          await new Promise((resolve, reject) => widget.saveChartToServer(resolve, reject,
            {chartName: workspace.name}));
        } catch (e) {
          send({ type: "error", error: "工作区初始化失败：" + (initialNativeSaveError || e?.message || String(e)) });
          // Saving can fail while the chart is usable. Keep the toolbar and
          // draft recovery available rather than abandoning initialization.
        } finally {
          initialNativeSave = false;
        }
      }
    }
    widget.headerReady().then(async()=>{
        studyTemplates=chartStudyTemplates(widget,prefs.templates,readonly,
          error=>send({type:'error',error:String(error)}));
        swingDisplay = chartSwingDisplay(widget,swingStore(),{root:document.getElementById('chart'),
          identity:symbol=>{const id=decode(symbol);return MWSeries.encode(id.symbol,id.series_kind);},
          chartTime:(time,chart)=>stamp({start:time,end:time+86400000},chart.resolution(),decode(chart.symbol()).symbol),
          report:error=>send({type:'error',error:'Swing 显示失败：'+String(error)})});
        squeezeDisplay = chartSqueezeDisplay(widget,squeezeStore(),{
          identity:symbol=>{const id=decode(symbol);return MWSeries.encode(id.symbol,id.series_kind);},
          report:error=>send({type:'error',error:'Rolling Range Squeeze 显示失败：'+String(error)})});
        alertBridge.attach();
        chartMenu = chartThemeMenu(widget, (e) =>
          send({ type: "error", error: String(e) }),
          grid, [
            ...[["系统消息","signals"],["历史演练","replay"],["设置","settings"],["兼容功能 · 旧版监控","legacy"]].map(([label,action]) => ({label, action, run:() => send({type:"workspace-action",action})})),
            {label: "历史加载详情", run: () => send({type:"history-load-details-open"})},
            {label: "取消历史加载", run: () => MWNativeNavigation.cancelAll()},
            {label: "历史数据容量", run: () => send({type:"history-capacity-open",usage:MWNativeNavigation.diagnostics().resident})},
            ...(!readonly ? [{label: "保存样式", title: "保存图表样式模板", run: async () => {
              try {
                const epoch = workspaceEpoch;
                const index = widget.activeChartIndex();
                const state = await new Promise((resolve) =>
                  widget.save(resolve),
                );
                const content = chartStyleTemplate(state, index, grid.value);
                const name = await request({}, "style-template-name");
                if (!name) return;
                if (epoch !== workspaceEpoch)
                  throw Error("工作区已切换，请重新保存样式");
                await prefs.templates.saveChartTemplate(name, content);
                emitNotice({source_kind:'preferences',attempt_id:crypto.randomUUID(),code:'CHART_TEMPLATE_SAVED',severity:'info',title:'样式已保存',message:'在图表设置 → 模板中选择应用。'});
              } catch (error) {
                send({ type: "error", error: String(error) });
              }
            }}] : []),
            {label: "修改密码", run: () => chartMenu.changePassword()},
            {label: "退出登录", action:"logout", run: () => send({type: "workspace-action", action: "logout"})},
            ...(!readonly ? [{label: "复制恢复草稿", recovery: true,
              run: () => send({type: "workspace-action", action: "recover"})}] : []),
          ], readonly ? undefined : () => send({type: "workspace-action", action: "create"}), autoSave, () => snapshot(), async body => {const result=await request(body,"account-password");emitNotice({source_kind:"preferences",attempt_id:crypto.randomUUID(),code:"ACCOUNT_PASSWORD_SAVED",severity:"info",title:"密码已修改",message:"其他设备需要重新登录。"});return result;}, barRangeMapping, syncCoordinator,
        );

      })
      .catch((e) => send({ type: "error", error: String(e) }));
    // Mobile is a temporary single-chart view of the saved desktop workspace.
    // Read-only adapters keep the original multi-chart document untouched.
    await restoreViewports();
    await rebuildMobileSingleChart();
    restoreChartSynchronization(widget, pendingSync);
    beforeInitialHistory = undefined;
    pendingSync = undefined;
    ready = true;
    loading = false;
    ordinaryNotices?.theme(widget.getTheme());
    send({ type: "theme-changed", theme: widget.getTheme() });
    alertUI?.theme(widget.getTheme());
    widget.subscribe("chart_theme_changed", (name, standard, onlyActive) => {
      alertUI?.theme(widget.getTheme());
      ordinaryNotices?.theme(widget.getTheme());
      send({ type: "theme-changed", theme: widget.getTheme() });
      if (!standard && !readonly) {
        prefs.templates.getChartTemplateContent(name)
          .then(({content}) => {
            if (["solid", "dotted"].includes(content._mwGridStyle))
              return grid.applyTemplate(content._mwGridStyle);
          })
          .catch(e => send({type: "error", error: "网格线样式恢复失败：" + String(e)}));
      }
      if (themeRestoring || !standard || onlyActive) return;
      const theme = String(name).toLowerCase() === "light" ? "Light" : "Dark";
      selectedTheme = theme;
      savedDoc.theme = theme;
      if (readonly) return;
      prefs
        .savePreference("setting", "mw.theme", theme)
        .catch((e) =>
          send({ type: "error", error: "主题保存失败：" + String(e) }),
        );
    });
    symbolFlags?.dispose();
    try {
      symbolFlags = MWSymbolFlags.attach(widget, preferences.find(p=>p.kind==="setting" && p.name===MWSymbolFlags.name), readonly,
        (op,args)=>request({op,args},"symbol-flags"), error=>send({type:"error",error:"收藏保存失败："+String(error)}),
        (error,attempt_id)=>emitNotice({source_kind:'preferences',attempt_id,code:'PREFERENCE_SAVE_FAILED',title:'收藏偏好保存失败',message:String(error||'收藏偏好已保存'),context:{source_id:'setting:mw.symbol-flags.v1',endpoint:'/advanced-charts/preferences/save'}},!error));
    } catch(error) {send({type:"error",error:"收藏增强不可用："+String(error)});}
    nativeWatchlists(
      widget,
      preferences.find(
        (p) => p.kind === "setting" && p.name === "mw.watchlists.v1",
      )?.content.value,
      readonly,
      (value) => prefs.savePreference("setting", "mw.watchlists.v1", value),
      (e) => send({ type: "error", error: "自选列表保存失败：" + String(e) }),
    ).catch((e) =>
      send({ type: "error", error: "自选列表初始化失败：" + String(e) }),
    );
    const bindEdgeSync = () => {
      edgeGuard?.dispose();
      const sessionRequests = new Map();
      edgeGuard = edgeRangeSync(
        widget,
        () => loading || viewportRestoring || historyReloading || !!rangeGuard?.busy(),
        (error) =>
          send({ type: "error", error: "时间范围同步失败：" + String(error) }),
        async (chart, target) => {
          if (decode(chart.symbol()).series_kind !== "managed") return target;
          const symbol = decode(chart.symbol()).symbol;
          if (target.to - target.from > 31 * 86400) return target;
          // An actual observed candle inside the target proves this is not
          // an entirely closed session. Ordinary pan/zoom needs no calendar RPC.
          const historyKey = chart.symbol() + '|' + chart.resolution();
          if ([firstHistory.get(historyKey),lastHistory.get(historyKey)].some(
            time => Number.isFinite(time) && time >= target.from*1000 && time < target.to*1000))
            return {...target,notice:""};
          const args = {instrument:symbol,start:Math.floor(target.from*1000),end:Math.ceil(target.to*1000)};
          const key = JSON.stringify(args);
          let lookup = sessionRequests.get(key);
          if (!lookup) {
            lookup = request({op:"viewport",args},"market");
            sessionRequests.set(key,lookup);
            lookup.finally(()=>{if(sessionRequests.get(key)===lookup)sessionRequests.delete(key);}).catch(()=>{});
          }
          const result = await lookup;
          const label = value => new Date(value * 1000).toISOString().slice(0, 16).replace("T", " ");
          const text = result.closed
            ? `${symbol}：目标区间休市，当前显示休市前行情（目标 ${label(target.from)} 至 ${label(target.to)} UTC）`
            : "";
          const step = Number(chart.resolution()) * 60;
          return result.closed ? {from: Math.min(result.start / 1000, result.end / 1000 - 2 * step), to: result.end / 1000 - step, notice: text} : {...target, notice: ""};
        },
        (chart, text) => send({type: "viewport-notice", key: String(Array.from({length: widget.chartsCount()}, (_, i) => widget.chart(i)).indexOf(chart)), text}),
      );
    };
    widget.subscribe("chart_load_requested", () => {
      invalidateAlertUI();
      barRangeMapping.suspend();
      send({type: "viewport-notice", key: "*", text: ""});
      edgeGuard?.dispose();
      edgeGuard = undefined;
      rangeGuard?.dispose();
      rangeGuard = undefined;
      // End held request observations under their original epoch. The parent
      // fences notice-source messages after native-load-reset, so doing this
      // after the reset would discard the end or mismatch its durable context.
      for(const [id] of subscriptions) feed.unsubscribeBars(id);
      for(const [id] of quoteSubscriptions) feed.unsubscribeQuotes(id);
      workspaceEpoch++;
      indicatorCoordinator?.dispose();indicatorCoordinator=undefined;indicatorBindings.clear();
      send({type:'native-load-reset',epoch:workspaceEpoch});
      syncCoordinator.resetWorkspace(pendingSync);
      workspaceLoadPause = syncCoordinator.acquirePause("workspace-load",["date","time","barWidth"]);
      quoteSnapshotRows.clear();
      quoteResetTokens.clear();
      marketHistoryState.clear();
      providerHistoryState.clear();
      providerHistoryWork.clear();
      lastHistory.clear();
      firstHistory.clear();
      fixedHistoryStarts.clear();
      fixedIndicatorPending.clear();
      alertCompositeRevisions.clear();
      indicatorHistoryNeeds.clear();
      alertCalculationOrigins.clear();
      managedSessions.clear();
      maintenanceAsked.clear();
      viewportRestoring = false;
      loading = true;
      dirty = false;
    });
    widget.subscribe("chart_loaded", async () => {
      const epoch = workspaceEpoch;
      await restoreTheme();
      if (epoch !== workspaceEpoch) return;
      await restoreViewports();
      if (epoch !== workspaceEpoch) return;
      // load() emits chart_loaded again for the rebuilt single chart. Only that
      // final event may rebind guards and release the loading state.
      if (await rebuildMobileSingleChart()) return;
      if (epoch !== workspaceEpoch) return;
      syncCoordinator.refreshCharts();
      restoreChartSynchronization(widget, pendingSync);
      beforeInitialHistory = undefined;
      pendingSync = undefined;
      workspaceLoadPause?.release();
      workspaceLoadPause = undefined;
      loading = false;
      if(!indicatorCoordinator)startIndicatorCoordinator(catalog);
      barRangeMapping.configure(pendingBarRange || {version:1,enabled:false,style:"background"}, true);
      synchronizeMarketVisibility();
      barRangeMapping.refreshCharts();
      rangeGuard?.dispose();
      rangeGuard = rangeSyncLoadingGuard(widget);
      bindEdgeSync();
      bindViewports();
      bindTimezoneEvents();
      bindActiveChartEvent();
      alertBridge.refresh();
      for(let index=0;index<widget.chartsCount();index++) MWNativeNavigation.recoverInitial(widget.chart(index));
      reportHistoryFailures();
      if (!alertUI) await alertUIAttach();
    });
    rangeGuard = rangeSyncLoadingGuard(widget);
    bindEdgeSync();
    bindViewports();
    bindTimezoneEvents();
    bindActiveChartEvent();
    widget.subscribe("layout_changed", () => {
      synchronizeMarketVisibility();
      syncCoordinator.refreshCharts();
      if (!loading) barRangeMapping.refreshCharts();
      send({type: "viewport-notice", key: "*", text: ""});
      rangeGuard?.refresh();
      edgeGuard?.refresh();
      bindViewports();
      bindTimezoneEvents();
      alertBridge.refresh();
    });
    widget.drawOnAllChartsEnabled().setValue(true);
    // Native onAutoSaveNeeded is debounced by five seconds. Reading that late
    // notification as a new edit can dirty a layout already saved after the
    // actual Undo command. Observe the same stack immediately so editRevision
    // identifies the real command rather than its delayed notification.
    const undoStack = widget._innerAPI()._chartWidgetCollection.undoHistory.undoStack();
    const undoChanged = command => {if(command?.affectsState()) markWorkspaceDirty();};
    undoStack.onChange().subscribe(null,undoChanged);
    addEventListener('pagehide',()=>undoStack.onChange().unsubscribe(null,undoChanged),{once:true});
    await alertUIAttach();
    send({ type: "ready" });
    clearInterval(progressivePoll);
    demandReporter?.dispose();
    demandReporter=undefined;
    poll = setInterval(() => {
      if(marketPollingFallback) {tick(); flushProviderCorrections();}
      demandReporter?.tick();
      if (manualSavePending) snapshot();
    }, 15000);
  });
}
// Events do not cross iframe boundaries; cover the host document as well.
addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey ||
      event.key.toLowerCase() !== "s" || nativeReadonly) return;
  event.preventDefault();
  snapshot();
});
addEventListener("message", async (e) => {
  if (
    e.source !== parent ||
    e.origin !== parentOrigin ||
    e.data?.channel !== "mw-chart-v1"
  )
    return;
  const m = e.data;
  if(m.type==='history-load-capacity' || m.type==='history-load-admitted') {
    if(m.type==='history-load-admitted' && m.history_client!==clientId) return;
    requestPolicy.capacity(m.available,m.type==='history-load-admitted' ? m.id : undefined);
    drain();
    return;
  }
  if(m.type==='notice-center-state' && m.session===alertUISession && m.workspace_id===alertUIWorkspace){noticeState=m.state;noticeUI?.update(m.state);alertUI?.noticeState(m.state);return;}
  if(m.type==='notice-center-open'){noticeOpenEvent=typeof m.event_id==='string'?m.event_id:'';if(noticeUI){noticeUI.open(noticeOpenEvent || undefined);noticeOpenEvent=undefined;}return;}
  if(m.type==='chart-alert-event-open' && typeof m.signal_id==='string' && /^[a-f0-9-]{36}$/.test(m.signal_id)) {
    if(alertUI)alertUI.event(m.signal_id);else {alertOpenSignal=m.signal_id;restoreAlertsPanel=true;}
    return;
  }
  if (m.type === "data-center-open" && ready && !loading && typeof m.location === "string" && m.location.length <= 4000) { dataCenter?.open(m.location); return; }
  if (m.type === 'chart-alert-ui-scope') {
    if (typeof m.session !== 'string' || typeof m.workspace_id !== 'string') return;
    alertUISession = m.session; alertUIDraft = m.draft; alertUIWorkspace = m.workspace_id;
    invalidateAlertUI();
    // The workspace result may still be in flight. Attach is gated by its ID;
    // Save As retries from onSaved, layout loads retry from chart_loaded.
    void alertUIAttach?.();
    return;
  }
  if (m.type === 'chart-alert-ui-context') {alertUI?.context(m.context); return;}
  if (m.type === 'chart-alert-ui-open') {alertUI?.open(); return;}
  if (m.type === "chart-alert-create" && ready && !loading) {void alertBridge?.create(); return;}
  if (m.type === "chart-alert-drawing-action" && typeof m.alert_id === "string" && ["retry","restore"].includes(m.action) && ready && !loading) {void alertBridge?.drawingAction(m.alert_id,m.action); return;}
  if (m.type === "chart-alert-rows" && Array.isArray(m.rows)) {alertBridge?.setRows(m.rows); return;}
  if (m.type === "chart-alert-locate" && m.row && JSON.stringify(m.row).length < 20_000 && ready && !loading) {void alertBridge?.locate(m.row,m.event); return;}
  if (m.type === "notifications" && Array.isArray(m.notices) && ready) {
    activeNotices = m.notices.slice(0, 24).filter(entry =>
      typeof entry.id === "string" && entry.id.length <= 2100 &&
      typeof entry.text === "string" && entry.text.length <= 2000 && entry.text)
      .map(entry => ({key: JSON.stringify([entry.id, entry.text]),
        text: entry.text.replace(/^(?:Error:\s*)+/, ""), recover: entry.recover === true && !nativeReadonly}));
    const live = new Set(activeNotices.map(entry => entry.key));
    for (const key of acknowledgedNotices) if (!live.has(key)) acknowledgedNotices.delete(key);
    chartMenu?.setDraftBlocked(m.draftBlocked === true);
    showNextNotice();
    return;
  }
  if(m.type==='market-event') {
    const event=m.event;
    const quote=[...quoteSubscriptions.values()].find(item=>item.listeners.some(entry=>entry.listener===event?.listener));
    if(quote) {
      const entry=quote.listeners.find(entry=>entry.listener===event.listener);
      if(event.generation!==entry.generation) return;
      if(entry.result_epoch && event.result_epoch && entry.result_epoch!==event.result_epoch) entry.sequence=0;
      if(event.result_epoch) entry.result_epoch=event.result_epoch;
      if(event.sequence<=entry.sequence) return;
      entry.sequence=event.sequence;
      if(event.type==='quotes') {
        const rows = event.quotes.map(({s,v})=>({s,n:entry.ticker,v}));
        for(const row of rows) if(row.s==='ok' && (!row.v?.fetch_status || row.v.fetch_status==='ok'))
          marketRequestNotice(quote,row.n,'quotes',null);
        rememberQuoteRows(rows);
        quote.lastRows = rows;
        quote.cb(rows.map(row => quoteSnapshotRows.get(row.n)).filter(Boolean).map(presentQuote));
      }
      if(event.type==='status' && (event.status==='error' || event.error)) {
        quote.cb(quoteFailureRows([entry.ticker]));
      }
      if(event.type==='reset') {
        quoteSnapshotRows.delete(entry.ticker);
        quoteResetTokens.set(entry.ticker, {});
        entry.generation=++marketGeneration;entry.sequence=0;
        send({type:'market-subscribe',args:{client:clientId,listener:entry.listener,generation:entry.generation,
          kind:'quotes',query:marketQuery(entry.ticker,'1'),sequence:0}});
      }
      return;
    }
    const sub=[...subscriptions.values()].find(item=>item.marketListener===event?.listener);
    if(!sub || event.generation!==sub.marketGeneration) return;
    // Native caches can retain the old source after a symbol/period switch.
    // Its late reset must not re-register demand or mutate the new viewport.
    if(ready && !loading) synchronizeMarketVisibility();
    if(sub.marketPaused) return;
    if(sub.marketResultEpoch && event.result_epoch && sub.marketResultEpoch!==event.result_epoch) {
      sub.marketSequence=0;
      event.type='reset';event.reason='result_epoch_changed';
    }
    if(event.result_epoch) sub.marketResultEpoch=event.result_epoch;
    if(event.sequence<=sub.marketSequence) return;
    sub.marketSequence=event.sequence;
    const acceptedState=marketHistoryState.get(sub.symbol+'|'+sub.res+'|'+(sub.window || ''));
    if(event.dependency_observed_at!=null && acceptedState)acceptedState.dependency_observed_at=event.dependency_observed_at;
    if(event.dependency_revision!=null){
      const binding=indicatorBindings.get(indicatorKey(sub.symbol,sub.res));if(binding)binding.dependencyRevision=event.dependency_revision;
    }
    if(event.indicator_correction){
      compositeDisplayBatches.cancel(indicatorKey(sub.symbol,sub.res));
      if(event.initial_input_revision!=null && acceptedState)acceptedState.input_revision=event.initial_input_revision;
      rememberIndicatorBinding(sub.symbol,sub.res,event,{correction:true});
    }
    if(event.type==='reset') {
      compositeDisplayBatches.cancel(indicatorKey(sub.symbol,sub.res));
      rememberIndicatorBinding(sub.symbol,sub.res,event,{correction:true});
      // Fence the old generation while asynchronous native recovery runs.
      // Its replacement is registered only after the new history is accepted.
      sub.marketGeneration=++marketGeneration;
      sub.marketSequence=0;
      sub.needsHistoryReload=true;
      marketHistoryState.delete(sub.symbol+'|'+sub.res+'|'+(sub.window || ''));
      const historyKey=sub.symbol+'|'+sub.res+(decode(sub.symbol).series_kind==='provider' ? '|'+(sub.window || '') : '');
      lastHistory.delete(historyKey);
      firstHistory.delete(historyKey);
      cache.clear();
      sub.last=0;
      await recoverMarketBar(sub);
    } else if(event.type==='bars' && !sub.historical && !sub.needsHistoryReload) {
      const identity=decode(sub.symbol);
      if(!identity.spec && (identity.series_kind==='composite' && event.display_snapshot_id ||
          identity.series_kind==='provider' && event.provider_snapshot_id)){
        const generation=sub.marketGeneration;
        compositeDisplayBatches.enqueue(indicatorKey(sub.symbol,sub.res),sub,event,
          ()=>[...subscriptions.values()].includes(sub) && sub.marketGeneration===generation &&
            !sub.marketPaused && !sub.needsHistoryReload);
      }else acceptMarketBars(sub,event);
    } else if(event.type==='status' && event.error) {
      send({type:'feed-poll-state',key:sub.symbol+'|'+sub.res,error:event.error});
    }
    return;
  }
  if(m.type==='provider-event') {
    const event=m.event,sub=[...subscriptions.values()].find(s=>s.providerListener===event?.listener);
    if(!sub) return;
    const key=sub.symbol+'|'+sub.res;
    const old=providerHistoryState.get(key);
    if(event.type!=='error' && !historyOlder({cache_revision:event.revision,as_of:event.as_of},old))
      providerHistoryState.set(key,{revision:event.revision||0,observed_at:event.as_of||0,
        cursor:Math.max(old?.cursor||0,event.cursor||0)});
    if(event.type==='reset') {
      compositeDisplayBatches.cancel(indicatorKey(sub.symbol,sub.res));
      rememberIndicatorBinding(sub.symbol,sub.res,{...event,cache_revision:event.revision},{correction:true});
      await reviewProviderReset(sub,event).catch(error=>{
        if(error.code!=='HISTORY_CANCELLED') send({type:'error',error:'历史检查未完成：'+String(error)});
      });
    } else if(event.type==='bars') {
      if(sub.needsHistoryReload) {
        if(await reloadHistory(sub.symbol,sub.res,chart=>providerWindowMatches(chart,sub)))sub.needsHistoryReload=false;
        return;
      }
      if (sub.historical) return;
      const rows=barsOf({bars:event.bars,indicators:event.indicators||[]},sub.res,sub.symbol);
      if (historyOlder({cache_revision:event.revision,as_of:event.as_of},old)) return;
      const identity=decode(sub.symbol);
      if(!identity.spec && event.provider_snapshot_id){
        const generation=sub.marketGeneration;
        compositeDisplayBatches.enqueue(indicatorKey(sub.symbol,sub.res),sub,event,
          ()=>[...subscriptions.values()].includes(sub) && sub.marketGeneration===generation &&
            !sub.needsHistoryReload && !sub.historical);
        return;
      }
      if(identity.spec?.name==='ROLLING_RANGE_SQUEEZE') publishSqueeze(MWSeries.encode(identity.symbol,identity.series_kind),sub.res,event);
      if(identity.spec?.name==='SWING_SR_V1') {
        swingStore().publish(MWSeries.encode(identity.symbol,identity.series_kind),sub.res,event,swingStore().ticket());
        swingDisplay?.refresh();
      }
      for(const bar of rows) if(bar.time>=sub.last) {sub.cb({...bar});observeRangeBars(sub.symbol,sub.res,event.bars,[bar],sub.window);sub.last=bar.time;}
      rememberIndicatorBinding(sub.symbol,sub.res,{...event,cache_revision:event.revision});
    } else if(event.type==='error') {
      send({type:'error',error:event.error||'平台行情暂不可用，后台重试中'});
    }
    return;
  }
  if (m.type === "result") {
    if(m.history_client!==undefined && m.history_client!==clientId) return;
    requestPolicy.completed(m.id);
    const p = pending.get(m.id);
    if (!p) {drain();return;}
    pending.delete(m.id);
    clearTimeout(p.timer);
    clearTimeout(p.cancellationTimer);
    m.error ? p.reject(Object.assign(Error(m.error),m.errorDetails)) : p.resolve(m.result);
    drain();
  } else if (m.type === "history-capabilities") {
    MWNativeNavigation.setCapabilities(m.capabilities);
    edgeGuard?.retry();
    globalThis.MW_HISTORY_CAPABILITIES=m.capabilities;
  } else if (m.type === "history-capacity-open") {
    send({type:"history-capacity-open",usage:MWNativeNavigation.diagnostics().resident});
  } else if (m.type === "cancel-history") {
    MWNativeNavigation.cancelAll();
  } else if(m.type==='retry-chart-indicators' && m.epoch===workspaceEpoch && Number.isSafeInteger(m.index)) {
    if(ready && m.index>=0 && m.index<widget.chartsCount()){
      const chart=widget.chart(m.index);
      const symbol=chart.symbol(),resolution=chart.resolution();
      const recovery=displayRecoveries.get(indicatorKey(symbol,resolution));
      if(recovery?.state==='error'){
        try{await recoverDisplaySnapshot(symbol,resolution,recovery.token,true);}catch{return;}
        if(m.epoch!==workspaceEpoch || !ready || m.index>=widget.chartsCount() ||
            (widget.chart(m.index)._chartWidget || widget.chart(m.index))!==(chart._chartWidget || chart) ||
            chart.symbol()!==symbol || chart.resolution()!==resolution)return;
      }
    }
    void indicatorCoordinator?.retry(m.index);
  } else if (m.type === 'retry-chart-resolve' && ready && !loading && m.epoch===workspaceEpoch &&
      Number.isSafeInteger(m.index) && m.index>=0 && m.index<widget.chartsCount()) {
    const chart=widget.chart(m.index),target=chartResolves.get(resolveChartKey(chart));
    if(target && resolveCurrent(target) && target.generation===m.generation && target.state==='error' && Date.now()>=target.retryAt) {
      // v31 caches rejected resolves even across resetData/source restarts.
      // Evict only this symbol's rejected promises, then allocate a new series
      // identity on the requesting chart. Successful metadata stays cached.
      // This adapter is pinned to, and integration-tested against, licensed v31.
      try {
        const source=chart._chartWidget?.model().model().mainSeries().seriesSource();
        const cache=source?._gateway?._getChartApi?.()._studyEngine?._resolveRequests;
        if(typeof source?.stop!=='function' || typeof source?.start!=='function' || !cache)
          throw Error('当前图表无法重新解析，请重新打开此工作区');
        target.state='loading';
        target.message='正在重新解析行情身份，完成后可创建告警';
        reportResolveStates();
        for(const key of Object.keys(cache)) {
          if(key!==target.symbol && !key.startsWith(target.symbol+'_#_'))continue;
          const promise=cache[key];
          const rejected=await promise.then(()=>false,()=>true);
          if(!resolveCurrent(target))return;
          if(rejected && cache[key]===promise)delete cache[key];
        }
        if(!resolveCurrent(target))return;
        source.stop(); source.start();
      } catch(error) {
        if(!resolveCurrent(target))return;
        target.state='error';
        target.message='重新解析未完成，请重新打开此工作区';
        reportResolveStates();
      }
    }
  } else if (m.type === 'retry-chart-history' && ready && !loading && m.epoch===workspaceEpoch &&
      Number.isSafeInteger(m.index) && m.index>=0 && m.index<widget.chartsCount()) {
    const chart=widget.chart(m.index);
    if(chart.symbol()===m.symbol && chart.resolution()===m.resolution) MWNativeNavigation.recoverInitial(chart,true);
  } else if (m.type === "init" && !widget) {
    requestPolicy.capacity(m.history_load_available);
    alertUISession = m.alert_ui_session;
    noticeState = m.notice_state;
    alertUIDraft = m.alert_ui_draft;
    alertUIWorkspace = String(m.workspace?.id);
    MWNativeNavigation.setCapabilities(m.history_capabilities);
    globalThis.MW_HISTORY_CAPABILITIES=m.history_capabilities;
    globalThis.MWPreferenceDraftKeys = Array.isArray(m.preference_draft_keys) ? m.preference_draft_keys : [];
    boot(m.document, m.readonly, m.catalog, m.preferences, m.workspace, m.initial_symbol, m.watchlist_metadata);
  }
  else if (m.type === 'refresh-managed') await refreshManagedHistory(m.instrument);
  else if (m.type === 'preference-draft-resolve' && activePreferences) {
    activePreferences.resolveDraft(m.draft,m.action,m.revision).then(
      () => send({type:'preference-draft-result',request:m.request}),
      error => send({type:'preference-draft-result',request:m.request,error:String(error)}));
  }
  else if (m.type === "capture-draft" && ready && widget) {
    try {
      const state = await captureWorkspaceState();
      send({type:"draft-captured",workspace_id:alertUIWorkspace,document:{...savedDoc,engine:"tv31",schemaVersion:1,state}});
    } catch (error) { send({type:"error",error:"草稿捕获失败："+String(error)}); }
  }
  else if (m.type === "discard-changes") { discardWorkspaceChanges?.(); }
  else if (m.type === "app-state") chartMenu?.setPending?.(m.pending);
  else if (m.type === "open-alerts") { restoreAlertsPanel = true; alertUI?.open?.(); }
  else if (m.type === "save") snapshot();
  else if (m.type === "theme" && ready) {
    savedDoc.theme = m.theme;
    await widget.changeTheme(m.theme);
    snapshot();
  }
});
send({ type: "loaded" });

addEventListener("pagehide", () => {
  resolveDisposed=true; chartResolves.clear();
  compositeDisplayBatches.dispose();
  activePreferences?.dispose();
  indicatorCoordinator?.dispose();
  ordinaryNotices?.dispose();
  noticeUI?.destroy();
  alertUI?.destroy();
  alertBridge?.destroy();
  watchlistLayout?.dispose();
  symbolFlags?.dispose(); activeTab?.dispose();
  unbindActiveChartEvent();
  for (const [api, changed] of timezoneBindings) api.onTimezoneChanged().unsubscribe(null, changed);
  timezoneBindings.clear();
  for (const [chart, changed] of timezoneSymbolBindings) chart.onSymbolChanged().unsubscribe(null, changed);
  timezoneSymbolBindings.clear();
  globalThis.MWChartMaximize?.dispose();barRangeMapping?.dispose();syncCoordinator?.dispose();
}, {once:true});
