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
const replacements = [
  ['class h{constructor(e,t){this._bars=[],this._invalidated=!0',
   `class h{constructor(e,t){${runtime}?.bindModel(t);this._bars=[],this._invalidated=!0`],
  ['destroy(){this._abortController.abort(),this.clearIntervals()',
   `destroy(){${runtime}?.unbindModel(this);this._abortController.abort(),this.clearIntervals()`],
  ['this._datafeed=e,this._symbolInfo=t,this._interval=Ne.Interval.parse(i)',
   `this._datafeed=e,this._symbolInfo=t,${runtime}?.bindThread(this,t,i),this._interval=Ne.Interval.parse(i)`],
  ['destroy(){0!==this._subscribers.length&&this._logWarning',
   `destroy(){${runtime}?.unbindThread(this);0!==this._subscribers.length&&this._logWarning`],
  ['i-e.countBack)))', `i-e.countBack-(${runtime}?.extraFromCache(this,e,i)||0))))`],
  ['s.endOfData=!0),e.onHistoryCallback(s)',
   `s.endOfData=(${runtime}?.enabled()&&this._symbolInfo.ticker?.startsWith("MWP:")?s.bars[0]?.time===this._cache.bars[0]?.time:!0)),e.onHistoryCallback(s)`],
];
const digest = text => createHash('sha256').update(text).digest('hex');
if (digest(source) !== expected) {
  let original = source;
  for (const [before, after] of replacements) original = original.replace(after, before);
  if (digest(original) !== expected)
    throw Error('Unsupported licensed bundle: supply the original verified v31.1.0 distribution');
  if (disabled) {writeFileSync(file, original);console.log('Restored verified original native bundle');process.exit(0);}
  if (replacements.some(([, after]) => source.split(after).length !== 2))
    throw Error('Incomplete native reserve hooks: restore the verified original bundle before installing');
  console.log('Verified existing native reserve hooks');
  process.exit(0);
}
if (disabled) {console.log('Verified original native bundle; hooks disabled');process.exit(0);}
for (const [before, after] of replacements) {
  if (source.split(before).length !== 2) throw Error('Native hook anchor mismatch');
  source = source.replace(before, after);
}
writeFileSync(file, source);
console.log('Installed verified native reserve hooks');
