// Repair a toolbar subscription lifetime in the privately supplied v31.1.0 bundle.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const file = process.argv.slice(2).find(x => !x.startsWith('--')) || fileURLToPath(new URL(
  'charting_library/bundles/restricted-toolset.4fbfc823d8551bbb3e53.js', import.meta.url));
const expected = '3898bb2184d6a736de093f9faa93c0c2a4528a1ee7c7dd68232b255fa9dea76b';
const replacements = [
  ['r.linking.getChartWidget()?.model().mainSeries().symbolResolved().subscribe(null,this._onSymbolInfoResolved,!1)',
   '(this._mwResolvedEvent=r.linking.getChartWidget()?.model().mainSeries().symbolResolved(),this._mwResolvedEvent?.subscribe(null,this._onSymbolInfoResolved,!1))'],
  ['(0,n.isFeaturesetEnabled)("use_symbol_name_for_header_toolbar")&&r.linking.getChartWidget()?.model().mainSeries().symbolResolved().unsubscribe(null,this._onSymbolInfoResolved)',
   '(this._mwResolvedEvent?.unsubscribe(null,this._onSymbolInfoResolved),this._mwResolvedEvent=void 0)'],
];
const digest = text => createHash('sha256').update(text).digest('hex');
let source = readFileSync(file, 'utf8');
if (digest(source) !== expected) {
  if (!replacements.every(([, after]) => source.split(after).length === 2))
    throw Error('Unsupported or incomplete native toolbar hooks');
  for (const [before, after] of replacements) source = source.replace(after, before);
  if (digest(source) !== expected) throw Error('Unsupported licensed toolset: restore verified v31.1.0');
}
if (!process.argv.includes('--disable')) {
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw Error('Native toolbar anchor mismatch');
    source = source.replace(before, after);
  }
}
writeFileSync(file, source);
console.log('Verified native toolbar lifetime');
