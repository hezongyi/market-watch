// Install hooks into a privately supplied licensed distribution; never publish it.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const file = resolve(process.argv.slice(2).find(x=>!x.startsWith('--')) ||
  fileURLToPath(new URL('charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js',import.meta.url)));
const disabled = process.argv.includes('--disable');
let source = readFileSync(file, 'utf8');
const expected = '114428b8dde6eb137fd7ef3bc20ef35882189186c4bd092bb743b64d11682be1';
const runtime = 'globalThis.parent?.MWNativeReserve';
const navigation = 'globalThis.parent?.MWNativeNavigation';
const previous = [
  ['class h{constructor(e,t){this._bars=[],this._invalidated=!0',
   `class h{constructor(e,t){${runtime}?.bindModel(t);globalThis.parent?.MWNativeNavigation?.bindModel(t);this._bars=[],this._invalidated=!0`],
  ['destroy(){this._abortController.abort(),this.clearIntervals()',
   `destroy(){${runtime}?.unbindModel(this);globalThis.parent?.MWNativeNavigation?.unbindModel(this);this._abortController.abort(),this.clearIntervals()`],
  ['this._datafeed=e,this._symbolInfo=t,this._interval=Ne.Interval.parse(i)',
   `this._datafeed=e,this._symbolInfo=t,${runtime}?.bindThread(this,t,i),${navigation}?.bindThread(this,i),this._interval=Ne.Interval.parse(i)`],
  ['destroy(){0!==this._subscribers.length&&this._logWarning',
   `destroy(){${runtime}?.unbindThread(this);${navigation}?.unbindThread(this);0!==this._subscribers.length&&this._logWarning`],
  ['i-e.countBack)))', `i-e.countBack-(${runtime}?.extraFromCache(this,e,i)||0))))`],
  ['s.endOfData=!0),e.onHistoryCallback(s)',
   `s.endOfData=(${runtime}?.enabled()&&this._symbolInfo.ticker?.startsWith("MWP:")?s.bars[0]?.time===this._cache.bars[0]?.time:!0)),e.onHistoryCallback(s)`],
  ['this.stopTimeScaleAnimation()\n;let o=',
   `if(${navigation}?.prepareNavigation(this,e,t,(d)=>(0,Ce.cal_to_utc)((0,Ce.get_timezone)((0,n.ensureNotNull)(this.timezoneExceptExchange().value())),new Date(d))))return r.promise;this.stopTimeScaleAnimation()\n;let o=`],
  ['_getResolvingSymbolObject(){let e=this._getSymbolObject(this._symbolForResolve());',
   `_getResolvingSymbolObject(){let e=this._getSymbolObject(this._symbolForResolve());e=${navigation}?.decorate(this._model,e)||e;`],
  ['const c=new xS,h=(0,Xv.decodeExtendedSymbol)(e),d="string"!=typeof h.symbol?h.symbol:h;',
   `const c=new xS,h=(0,Xv.decodeExtendedSymbol)(e),d="string"!=typeof h.symbol?h.symbol:h;r=${navigation}?.windowInfo(r,d["mw-window"])||r;`],
  ['this._host.resolve(t,i,(e=>{r&&e.regular_session',
   `this._host.resolve(t,i,(e=>{e=${navigation}?.windowInfo(e,o.mw_window)||e;r&&e.regular_session`],
  ['function wS(e,t){return e.ticker+',
   'function wS(e,t){return (e.mw_window?e.mw_window+"_#_":"")+e.ticker+'],
  ['_ensureRequestedTo(e){let t;',
   `_ensureRequestedTo(e){${navigation}?.anchorThread(this,e);let t;`],
  ['setVisibleRange(e,t){return new Promise',
   `setVisibleRange(e,t){const p=${navigation}?.prepareRange(this._chartWidget.model().model(),e,()=>this.setVisibleRange(e,t));if(p)return p;return new Promise`],
  ['async gotoTimeRange(e,t,i){const s=this.timeScale(),',
   `async gotoTimeRange(e,t,i){if(!i){const p=${navigation}?.prepareRange(this,{from:e/1e3,to:t/1e3},()=>this.gotoTimeRange(e,t));if(p)return p;}const s=this.timeScale(),`],
  ['this._threads[i].removeSubscription(s):this._logWarning',
   `(this._threads[i].removeSubscription(s),${navigation}?.collectThreads(this)):this._logWarning`],
  ['this._errorMessage=e||null,this._processPendingSubscribers()',
   `this._errorMessage=e||null,${navigation}?.historyFailure(this,e)||this._processPendingSubscribers()`],
  ['distance(e,t){if(!this.isValid())return{success:!1};',
   'mwRequiredCount(e,t,i){const s=this._symbolInfo;return(0,ee.getPeriodsBetweenDates)(s.session,s.session_holidays,s.corrections,i.letter(),i.multiplier(),e*1e3,t*1e3)}mwDistance(e,t){return(0,te.extrapolateBarsFrontToTime)(this.barBuilder(),e*1e3,t*1e3,20000,!1).count}distance(e,t){if(!this.isValid())return{success:!1};'],
];
// Continuous history keeps only cache delivery, lifetime and recoverable-error
// hooks plus public navigation lifetime. No window identity or extrapolation.
const continuousV1 = [previous[0],previous[1],previous[2],previous[3],previous[4],previous[5],previous[11],previous[15]];
const continuousV2 = [...continuousV1, previous[12]];
// The native engine binds _updateTimeScale during model construction, before
// runtime bindModel runs. Hook the actual entry rather than that later property.
const continuousV3 = [...continuousV2, ['_updateTimeScale(e){const{index:t,',
  `_updateTimeScale(e){${navigation}?.timeScaleUpdated(this);const{index:t,`]];
const continuousV4 = [...continuousV2,
  ['this.lightUpdate()}_getAvailableCurrencies(){',
   `this.lightUpdate();${navigation}?.timeScaleUpdated(this)}_getAvailableCurrencies(){`]];
const continuousV5 = [...continuousV4,
  ['setVisibleTimeRange(e,t,i,s,r,o,a,l,c,h){let d=s,',
   'setVisibleTimeRange(e,t,i,s,r,o,a,l,c,h){const mwVersions=this._mwRangeVersions??=(new Map),mwVersion=(mwVersions.get(e)||0)+1;mwVersions.set(e,mwVersion);let d=s,'],
  ['const p=()=>{const s=this._studyEngine.sessionTimeScale(e);',
   'const p=()=>{if(mwVersions.get(e)!==mwVersion)return;const s=this._studyEngine.sessionTimeScale(e);']];
const continuousV6 = [...continuousV4,
  ['setVisibleTimeRange(e,t,i,s,r,o,a,l,c,h){let d=s,',
   `setVisibleTimeRange(e,t,i,s,r,o,a,l,c,h){const mwCurrent=${navigation}?.engineRangeCurrent()||(()=>true),mwVersions=this._mwRangeVersions??=(new Map),mwVersion=(mwVersions.get(e)||0)+1;mwVersions.set(e,mwVersion);let d=s,`],
  ['const p=()=>{const s=this._studyEngine.sessionTimeScale(e);',
   'const p=()=>{if(!mwCurrent()||mwVersions.get(e)!==mwVersion)return;const s=this._studyEngine.sessionTimeScale(e);']];
const continuousV7 = [...continuousV6,
  ['applyStudyTemplate(e,t,i){const s=new xl(this._model(),e,t,i);',
   `applyStudyTemplate(e,t,i){${navigation}?.admitTemplate(this._model(),e);const s=new xl(this._model(),e,t,i);`]];
const continuousV8 = [...continuousV7,
  ['this._initialGroupsState=e.lineToolsGroupModel().state()}redo(){this._model.mainSeries().setSymbolParams(this._newSymbolParams);',
   `this._initialGroupsState=e.lineToolsGroupModel().state()}redo(){${navigation}?.admitTemplate(this._model,this._templateContent);this._model.mainSeries().setSymbolParams(this._newSymbolParams);`],
  ['undo(){this._model.mainSeries().setSymbolParams(this._initialSymbolParams),this._merge(this._initialState,1)',
   `undo(){${navigation}?.admitTemplate(this._model,this._initialState);this._model.mainSeries().setSymbolParams(this._initialSymbolParams),this._merge(this._initialState,1)`]];
const continuousV9 = [...continuousV8,
  ['redo:function(){if(s.isEmpty())return!1;const e=s.pop();',
   `redo:function(){if(s.isEmpty())return!1;${navigation}?.admitHistory(s.head(),"redo");const e=s.pop();`],
  ['undo:function(){if(i.isEmpty())return!1;const e=i.pop();',
   `undo:function(){if(i.isEmpty())return!1;${navigation}?.admitHistory(i.head(),"undo");const e=i.pop();`],
  ['for(;!i.isEmpty()&&e.lastActualCommand!==i.head();)i.pop().undo(r);',
   `for(;!i.isEmpty()&&e.lastActualCommand!==i.head();){${navigation}?.admitHistory(i.head(),"undo");i.pop().undo(r);}`]];
const replacements = [...continuousV9,
  ['undoToCheckpoint:function(e){for(',
   `undoToCheckpoint:function(e){${navigation}?.admitCheckpoint(i,e);for(`]];
const continuousHooks = replacements.map(pair => [...pair]);
replacements.push(['s&&this._drawSources(e,t)}if(null!==this._state)',
 's&&(globalThis.parent?.MWBarRangeRenderer?.draw(this,e,t),this._drawSources(e,t))}if(null!==this._state)']);
replacements.push(['syncSourceTarget(){return{uniqueId:',
 'mwRangeSlot(e,internal=!1){if(internal&&/[DWM]$/.test(String(this._resolution))){const z=i(123226),d=this._session.spec.correctTradingDay(z.utc_to_cal(this._session.timezone,e));z.set_hms(d,0,0,0,0,z.get_timezone("Etc/UTC"));e=d.getTime()}const session=this._symbolInfo.mw_range_source==="yahoo"&&/[DWM]$/.test(String(this._resolution))?new Q.SessionInfo(this._symbolInfo.timezone,"0000-0000:1234567"):this._session;const b=(0,ee.newBarBuilder)(this._resolution,session,new Q.SessionInfo("Etc/UTC","24x7"));b.moveTo(e);return{start:b.startOfBar(0),end:b.endOfBar?.(0)??b.startOfBar(1)}}syncSourceTarget(){return{uniqueId:']);
// The native saver compares its captured state before calling our adapter.
// Include host configuration in that comparison so a config-only edit saves.
replacements.push(['return e?n=!0:(t=!0,s=!1),this._chartWidgetCollection.state({withData:!!e,skipLineToolsFromOtherSymbols:!!i,wipeSensitiveData:!!s,skipLineTools:r,skipHiddenSources:n,addOnlyActiveChart:!t})}',
 'return e?n=!0:(t=!0,s=!1),Object.assign(this._chartWidgetCollection.state({withData:!!e,skipLineToolsFromOtherSymbols:!!i,wipeSensitiveData:!!s,skipLineTools:r,skipHiddenSources:n,addOnlyActiveChart:!t}),globalThis.parent?.MWBarRangeMapping?{_mwBarRangeMapping:globalThis.parent.MWBarRangeMapping.snapshot()}:{})}']);
// Preserve the previous complete revision so upgrades can reverse it to the
// same verified original before installing the expanded adapter.
const rangeHooks = replacements.map(pair => [...pair]);
const legacyRangeHooks = [...previous, ...replacements.slice(continuousHooks.length)];
const nativeSync = 'globalThis.parent?.MWNativeSync';
const savePair = replacements[replacements.length-1];
replacements[replacements.length-1] = [savePair[0],savePair[1].replace(':{})}', ':{} ,globalThis.parent?.MWSyncCoordinator?{_mwSync:globalThis.parent.MWSyncCoordinator.snapshot()}:{})}')];
replacements.push(
  ['_handleDateRangeLockChange(e){this._loadingContent?',
   `_handleDateRangeLockChange(e){if(${nativeSync}?.handleChoice(this,"date",e,Cf))return;this._loadingContent||${nativeSync}?.internalWrite()?`],
  ['_handleTrackTimeLockChange(e){this._loadingContent?',
   `_handleTrackTimeLockChange(e){if(${nativeSync}?.handleChoice(this,"time",e,Tf))return;this._loadingContent||${nativeSync}?.internalWrite()?`],
  ['_height(){return this._options.height.value()}',
   `_height(){return Math.max(1,this._options.height.value()-(${nativeSync}?.railHeight(this)||0))}`],
  ['zoomOut(){const e=this.timeScale().width();this.canZoomOut()&&(0,Vo.doAnimate)({to:e/5,onStep:e=>{this.startScaleTime(0),this.scaleTimeTo(e),this.endScaleTime()}})}',
   `zoomOut(){const e=this.timeScale().width();if(this.canZoomOut()){const t=${nativeSync}?.begin(this.model(),"zoom-out");(0,Vo.doAnimate)({to:e/5,onStep:e=>{const f=()=>{this.startScaleTime(0),this.scaleTimeTo(e),this.endScaleTime()};${nativeSync}?${nativeSync}.step(t,f):f()},onComplete:()=>${nativeSync}?.end(t)})}}`],
  ['zoomIn(){const e=this.timeScale().width();this.canZoomIn()&&(0,Vo.doAnimate)({to:e/5,onStep:e=>{this.startScaleTime(e),this.scaleTimeTo(0),this.endScaleTime()}})}',
   `zoomIn(){const e=this.timeScale().width();if(this.canZoomIn()){const t=${nativeSync}?.begin(this.model(),"zoom-in");(0,Vo.doAnimate)({to:e/5,onStep:e=>{const f=()=>{this.startScaleTime(e),this.scaleTimeTo(0),this.endScaleTime()};${nativeSync}?${nativeSync}.step(t,f):f()},onComplete:()=>${nativeSync}?.end(t)})}}`],
  ['this.model().model().zoomTime(r,t,!!o||void 0),this._onZoom.fire(o)',
   `(${nativeSync}?${nativeSync}.run(this.model().model(),"wheel",()=>this.model().model().zoomTime(r,t,!!o||void 0)):this.model().model().zoomTime(r,t,!!o||void 0)),this._onZoom.fire(o)`],
  ['this._chartModel().zoomTime(e.x,r,!0),this._prevPinchScale=s',
   `(${nativeSync}?${nativeSync}.run(this._chartModel(),"pinch",()=>this._chartModel().zoomTime(e.x,r,!0)):this._chartModel().zoomTime(e.x,r,!0)),this._prevPinchScale=s`],
  ['t.timeScale().isEmpty()||t.startScaleTime(e.localX)',
   `t.timeScale().isEmpty()||(this._mwScaleToken=${nativeSync}?.begin(t.model(),"time-axis"),t.startScaleTime(e.localX))`],
  ['_pressedMouseOrTouchMoveEvent(e){this._zoomAvailable()&&this.chart.model().scaleTimeTo(e.localX)}',
   `_pressedMouseOrTouchMoveEvent(e){if(this._zoomAvailable()){const f=()=>this.chart.model().scaleTimeTo(e.localX);${nativeSync}?${nativeSync}.step(this._mwScaleToken,f):f()}}`],
  ['_mouseUpOrTouchEndEvent(e){this._zoomAvailable()&&(this._mousedown=!1,this.chart.model().endScaleTime(),this.restoreDefaultCursor())}',
   `_mouseUpOrTouchEndEvent(e){this._zoomAvailable()&&(this._mousedown=!1,this.chart.model().endScaleTime(),${nativeSync}?.end(this._mwScaleToken),this._mwScaleToken=null,this.restoreDefaultCursor())}`],
  ['a!==l.index&&o.zoomToViewport(l.index,a,l.price,r,t)',
   `a!==l.index&&(${nativeSync}?${nativeSync}.run(o.model(),"zoom-tool",()=>o.zoomToViewport(l.index,a,l.price,r,t)):o.zoomToViewport(l.index,a,l.price,r,t))`],
  ['(0,ae.trackEvent)("GUI","Double click time scale"),this.chart.model().resetTimeScale()',
   `(0,ae.trackEvent)("GUI","Double click time scale"),(${nativeSync}?${nativeSync}.run(this.chart.model().model(),"time-axis-reset",()=>this.chart.model().resetTimeScale()):this.chart.model().resetTimeScale())`],
);
const previousSyncHooks = replacements.map(([before, after]) => [before,
  after.replace(`if(${nativeSync}?.handleChoice(this,"date",e,Cf))return;`, '')
    .replace(`if(${nativeSync}?.handleChoice(this,"time",e,Tf))return;`, '')]);
replacements.push([
  '_handleChartSaved(e){e&&this._setContentHasChanges(!1)}',
  '_handleChartSaved(e){e&&this._setContentHasChanges(globalThis.parent?.MWNativeSave?.hasUnsavedChanges()===true)}',
]);
const legacy = previous.slice(0,6).map(([before, after])=>[before,after]);
legacy[0][1] = `class h{constructor(e,t){${runtime}?.bindModel(t);this._bars=[],this._invalidated=!0`;
legacy[1][1] = `destroy(){${runtime}?.unbindModel(this);this._abortController.abort(),this.clearIntervals()`;
legacy[2][1] = `this._datafeed=e,this._symbolInfo=t,${runtime}?.bindThread(this,t,i),this._interval=Ne.Interval.parse(i)`;
legacy[3][1] = `destroy(){${runtime}?.unbindThread(this);0!==this._subscribers.length&&this._logWarning`;
const legacySyncHooks = [...legacyRangeHooks.slice(0,-1), replacements[rangeHooks.length-1],
  ...replacements.slice(rangeHooks.length)];
const legacyPreviousSyncHooks = legacySyncHooks.slice(0,-1).map(([before, after]) => [before,
  after.replace(`if(${nativeSync}?.handleChoice(this,"date",e,Cf))return;`, "")
    .replace(`if(${nativeSync}?.handleChoice(this,"time",e,Tf))return;`, "")]);
const productionV112Hooks = replacements.map(pair => [...pair]);
// Replace only the native empty-pane action. Object/axis double clicks continue
// through their original handlers; do not add a second DOM dblclick listener.
replacements.push([
  'this._chartUndoModel().selection().isEmpty()){const t=this.state();new Er.EnvironmentState(e).mod()',
  'this._chartUndoModel().selection().isEmpty()&&!(null===t&&this._mwBlankDoubleClickCursor&&(0,Rt.toolIsCursor)(Rt.tool.value())&&!this._isSelectPointModeEnabled()&&null===this._firstZoomPoint&&!this._chartUndoModel().crosshairSource().startMeasurePoint()&&globalThis.parent?.MWChartMaximize?.handle(this,e))){const t=this.state();new Er.EnvironmentState(e).mod()',
]);
// Some tools reset to cursor while mouseUp completes the drawing/zoom, before
// the engine dispatches the double click. Retain the tool at mouseDown.
replacements.push([
  'mouseDownEvent(e){this._onMouseEvent(),this.hasState()&&this._mouseDownOrTouchStartEvent(e,this._dataSourceAtPoint(e.localX,e.localY))}',
  'mouseDownEvent(e){const mwCursor=(0,Rt.toolIsCursor)(Rt.tool.value())&&null===this._dataSourceAtPoint(e.localX,e.localY);this._mwBlankDoubleClickCursor=0===this._mouseEventHandler._clickCount?mwCursor:this._mwBlankDoubleClickCursor&&mwCursor;this._onMouseEvent(),this.hasState()&&this._mouseDownOrTouchStartEvent(e,this._dataSourceAtPoint(e.localX,e.localY))}',
]);
replacements.push([
  '_syncChartsDateRangesWithActiveChartRange(e){const t=this.activeChartWidget.value(),',
  '_syncChartsDateRangesWithActiveChartRange(e){if(globalThis.parent?.MWChartMaximize?.resizing())return;const t=this.activeChartWidget.value(),',
]);
const maximizedHooks = replacements.map(pair => [...pair]);
// Native quotes overwrite every returned scale with the storage symbol scale.
// Permit a host display scale only in quote presentation, retaining the source
// symbol scale for candles, calculations, drawing ticks and manual settings.
replacements.push([
  'pricescale:i.pricescale,minmov:i.minmov,minmove2:i.minmove2||0,fractional:i.fractional||!1',
  'pricescale:globalThis.parent?.chartQuoteScale?.(t,i)??i.pricescale,minmov:i.minmov,minmove2:i.minmove2||0,fractional:i.fractional||!1',
]);
const digest = text => createHash('sha256').update(text).digest('hex');
if (digest(source) !== expected) {
  const installed = [replacements, maximizedHooks, productionV112Hooks, legacySyncHooks, previousSyncHooks, legacyPreviousSyncHooks, rangeHooks, legacyRangeHooks, previous, continuousHooks, continuousV9, continuousV8, continuousV7, continuousV6, continuousV5, continuousV4, continuousV3, continuousV2, continuousV1, legacy].find(candidate=>
    candidate.every(([,after])=>source.split(after).length===2));
  if (!installed) throw Error('Incomplete native hooks: restore the verified original bundle before installing');
  let original = source;
  for (const [before, after] of installed) original = original.replace(after, before);
  if (digest(original) !== expected)
    throw Error('Unsupported licensed bundle: supply the original verified v31.1.0 distribution');
  if (disabled) {writeFileSync(file, original);console.log('Restored verified original native bundle');process.exit(0);}
  if (installed === replacements) {
    console.log('Verified existing continuous native hooks');process.exit(0);
  }
  source = original;
}
if (disabled) {console.log('Verified original native bundle; hooks disabled');process.exit(0);}
for (const [before, after] of replacements) {
  if (source.split(before).length !== 2) throw Error(`Native hook anchor mismatch (${source.split(before).length-1}): ${before.slice(0,120)}`);
  source = source.replace(before, after);
}
writeFileSync(file, source);
console.log('Installed verified native reserve hooks');
