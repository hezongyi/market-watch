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
const replacements = [
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
const legacy = replacements.slice(0,6).map(([before, after])=>[before,after]);
legacy[0][1] = `class h{constructor(e,t){${runtime}?.bindModel(t);this._bars=[],this._invalidated=!0`;
legacy[1][1] = `destroy(){${runtime}?.unbindModel(this);this._abortController.abort(),this.clearIntervals()`;
legacy[2][1] = `this._datafeed=e,this._symbolInfo=t,${runtime}?.bindThread(this,t,i),this._interval=Ne.Interval.parse(i)`;
legacy[3][1] = `destroy(){${runtime}?.unbindThread(this);0!==this._subscribers.length&&this._logWarning`;
const digest = text => createHash('sha256').update(text).digest('hex');
if (digest(source) !== expected) {
  const currentComplete = replacements.every(([, after])=>source.split(after).length===2);
  const legacyComplete = legacy.every(([,after])=>source.split(after).length===2);
  if (!currentComplete && !legacyComplete)
    throw Error('Incomplete native hooks: restore the verified original bundle before installing');
  let original = source;
  for (const [before, after] of currentComplete ? replacements : legacy) original = original.replace(after, before);
  if (digest(original) !== expected)
    throw Error('Unsupported licensed bundle: supply the original verified v31.1.0 distribution');
  if (disabled) {writeFileSync(file, original);console.log('Restored verified original native bundle');process.exit(0);}
  if (currentComplete) {
    console.log('Verified existing native reserve hooks');
    process.exit(0);
  }
  source = original;
}
if (disabled) {console.log('Verified original native bundle; hooks disabled');process.exit(0);}
for (const [before, after] of replacements) {
  if (source.split(before).length !== 2) throw Error('Native hook anchor mismatch');
  source = source.replace(before, after);
}
writeFileSync(file, source);
console.log('Installed verified native reserve hooks');
